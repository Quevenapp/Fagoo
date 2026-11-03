import { CARD_BRANDS, EXTENSION_FIELDS, KINDS, PAYMENT_TYPES, STATES, documentNumber, normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';
import { DocumentMirrorError, documentMirrorSummary, documentMirrorRecord, documentOriginTotals } from '../../../packages/erp-domain/src/document-mirror.mjs';
import {isCanonicalUnitPrice} from '../../../packages/erp-domain/src/unit-price.mjs';
// 202610200289: Lote and Busca customizada (Adicionar filtros) of the lists.
import {lotCodes,parseSearchParam} from '../../../packages/erp-domain/src/document-search.mjs';
// 202610200270: texto rico (Outros itens, Condições comerciais › Texto and the Cabeçalho personalizado of the prints).
import {normalizeRichText} from '../../../packages/erp-domain/src/rich-text.mjs';
import { DocumentReportError, documentReportOperation, documentReportResponse, documentReportRoute } from './document-reports.mjs';
import { XmlImportShapeError, xmlBody, xmlDraft, xmlImportResult } from './document-xml-import.mjs';
import { SITUATION_KINDS, SituationShapeError, occurrenceSituation, situationKey, situationValue, situationsPage, transitionEffects } from './document-situations.mjs';
// Documentos lane, wave G (202610200288 and later): the editor routes kept in their own module.
import { DocumentExtrasError, documentExtrasMethods, documentExtrasOperation, documentExtrasResponse, documentExtrasRoute } from './document-extras.mjs';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
// 202610200196: Total do IPI / ICMS ST, Preço lista and Código no fornecedor of the items, Forma and details of the parcelas.
// 202610200287: campos customizados of the OS.
const INPUT_FIELDS = ['date','contact_id','warehouse_id','expected_date','valid_until','next_contact','template','items','discount_mode','discount_value','freight','other_expenses','installments','notes','internal_notes','payment_terms','delivery_terms','equipment','serial_number','technician','defect','solution','commercial','tax_ipi','tax_icms_st','custom_fields',...EXTENSION_FIELDS];
// 202610200268: Peças / Serviços executados of the OS (group) with Orçar and OK of the serviço (quote, done).
// 202610200287: Informar lotes (lots), Garantia of the item of the OS (warranty_days) and IPI % of the pedido de compra (ipi_rate).
const ITEM_FIELDS = ['id','product_id','description','code','unit','quantity','unit_price','discount_percent','detailed_description','list_price','supplier_code','group','quote','done','lots','warranty_days','ipi_rate'];
const INSTALLMENT_FIELDS = ['due_date','amount','method','note','payment_reference','payment_method_id','details'];
const TOTAL_FIELDS = ['gross','line_discount','subtotal','discount','freight','other_expenses','total'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const picked = (value, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(value,key)).map(key => [key,value[key]]));
export class DocumentsError extends Error { constructor(status,code) { super(code); this.status=status; this.code=code; } }
// 202610200196: an allow-listed refusal of the document RPCs becomes its own code (the SQL message is never sent).
// 202610200239: OS permissions of Sistema › Usuários and the approval of the discount of the seller.
// 202610200269: a proposta with a newer version is read-only (Salvar nova versão).
// 202610200287: the lots, the casas decimais of the quantity and the campos customizados of the OS.
const REFUSALS={erp_document_origin_effects:[409,'ERP_DOCUMENT_ORIGIN_EFFECTS'],erp_document_deleted:[409,'ERP_DOCUMENT_DELETED'],erp_document_trash_reason:[400,'ERP_DOCUMENT_TRASH_REASON'],erp_document_credit_limit:[400,'ERP_DOCUMENT_CREDIT_LIMIT'],erp_document_permission_denied:[403,'ERP_DOCUMENT_PERMISSION_DENIED'],erp_document_version_locked:[409,'ERP_DOCUMENT_VERSION_LOCKED'],
  erp_document_discount_approval_required:[403,'ERP_DOCUMENT_APPROVAL_REQUIRED'],erp_document_item_lot_unavailable:[400,'ERP_DOCUMENT_LOT_UNAVAILABLE'],
  erp_document_quantity_decimals:[400,'ERP_DOCUMENT_QUANTITY_DECIMALS'],erp_document_custom_field_required:[400,'ERP_DOCUMENT_CUSTOM_FIELD_REQUIRED'],
  erp_document_custom_field_inactive:[400,'ERP_DOCUMENT_CUSTOM_FIELD_INACTIVE'],erp_document_custom_field_invalid:[400,'ERP_DOCUMENT_CUSTOM_FIELD_INVALID'],
  // 202610200288: Preferências › Sistema › Campos customizados › Ordem de Serviço.
  erp_document_custom_field_duplicate:[400,'ERP_DOCUMENT_CUSTOM_FIELD_DUPLICATE'],erp_document_custom_field_option_in_use:[400,'ERP_DOCUMENT_CUSTOM_FIELD_OPTION_IN_USE'],
  erp_document_custom_field_in_use:[400,'ERP_DOCUMENT_CUSTOM_FIELD_IN_USE'],erp_document_custom_field_limit:[400,'ERP_DOCUMENT_CUSTOM_FIELD_LIMIT'],
  // 202610200291: Checkout de pedidos.
  erp_document_checkout_exceeds:[400,'ERP_DOCUMENT_CHECKOUT_EXCEEDS'],erp_document_checkout_unavailable:[409,'ERP_DOCUMENT_CHECKOUT_UNAVAILABLE']};
export function documentsFailure(error){
  const match=typeof error?.upstreamMessage==='string'?REFUSALS[error.upstreamMessage]:undefined;
  return match&&error.status===match[0]?new DocumentsError(match[0],match[1]):error;
}
const invalid = () => { throw new DocumentsError(400,'ERP_INVALID_QUERY'); };
const badResponse = () => { throw new DocumentsError(502,'ERP_UPSTREAM_INVALID_RESPONSE'); };
const shape = read => { try { return read(); } catch (error) { if (error instanceof SituationShapeError || error instanceof XmlImportShapeError || error instanceof DocumentMirrorError) return badResponse(); throw error; } };
const validDate = value => {
  if(typeof value!=='string'||!/^(19|20)\d{2}-\d{2}-\d{2}$/.test(value))return false;
  const parsed=new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
};
// Origin-style list (202610190095): page or keyset cursor, ordering, multi-status and kind-specific filters.
const LIST_KEYS=['limit','after','page','order','status','q','date_from','date_to','date_type','warehouse_id','product_id','city','state','technician','equipment','serial_number','internal_note',
  // 202610200102 (Origin filters of pedidos, propostas e OS).
  'postal_code','district','tracking_code','customer_po_number','carrier','contact_email','template',
  // 202610200163: exact situações of the Gerenciador de transições (status-base or the id of a custom one).
  'situation',
  // 202610200164: native vendedor of pedidos, propostas and OS.
  'seller_id',
  // 202610200238: Origin "Componente" of the pedidos de venda (a component of the structure of a product of the pedido).
  'component_id',
  // 202610200268: Origin "Serviço" of the ordens de serviço (an item with that serviço; "Peça" is product_id).
  'service_id',
  // 202610200289: Origin "Lote (até 50 lotes separados por ;)" and "Busca customizada" (Adicionar filtros, JSON conditions).
  'lote','busca','origin'];
// Tipo de data per screen: Data de saída (pedidos e OS), Concluídos para e Garantia (OS).
const DATE_TYPES={sales_orders:['date','expected_date','ship_date'],sales_proposals:['date','next_contact'],service_orders:['date','expected_date','ship_date','finish_date','warranty_until'],purchase_orders:['date','expected_date']};
export const DOCUMENT_LIST_ORDERS=Object.freeze(['date_desc','date_asc','number_desc','number_asc']);
export const DOCUMENT_LIST_UFS=Object.freeze(['AC','AL','AM','AP','BA','CE','DF','ES','EX','GO','MA','MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO']);
const LIST_TEXT={city:[100,['sales_orders','sales_proposals']],technician:[200,['service_orders']],equipment:[200,['service_orders']],serial_number:[100,['service_orders']],internal_note:[200,['purchase_orders']],
  district:[100,['sales_orders']],tracking_code:[200,['sales_orders']],customer_po_number:[60,['sales_orders']],carrier:[200,['sales_orders']],contact_email:[254,['sales_proposals']]};
// SQL limits count characters (code points); a UTF-16 length would reject valid text with emoji.
const characters=value=>[...value].length;
const plainText=(value,max)=>typeof value==='string'&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value)&&value.trim().length>0;
function listArgs(kind,params){
  for(const key of params.keys())if(!LIST_KEYS.includes(key)||params.getAll(key).length!==1)invalid();
  const get=key=>params.get(key);
  const origin=get('origin');if(origin!==null&&!['all','origin','brufap'].includes(origin))invalid();
  // Without page/order the call keeps the 015 contract (UUID order + cursor) for current cursor callers.
  const paged=params.has('page')||params.has('order');
  const limit=get('limit')??'25',after=get('after'),page=get('page'),order=paged?get('order')??'date_desc':'id',status=get('status'),query=get('q'),from=get('date_from'),to=get('date_to'),dateType=get('date_type')??'date';
  if(!/^[0-9]{1,3}$/.test(limit)||Number(limit)<1||Number(limit)>100||(after!==null&&!UUID.test(after))||(page!==null&&(!/^[1-9][0-9]{0,5}$/.test(page)||Number(page)>100000||after!==null))
    ||(paged&&!DOCUMENT_LIST_ORDERS.includes(order))||!(dateType==='date'||DATE_TYPES[kind].includes(dateType))
    ||(query!==null&&(query.length>120||/[\x00-\x1f\x7f]/.test(query)))||(from!==null&&!validDate(from))||(to!==null&&!validDate(to))||(from!==null&&to!==null&&from>to))invalid();
  let statuses=null;
  if(status!==null){
    statuses=status.split(',');
    // Leva H (392): "deleted" is the lixeira (Excluídos).
    if(statuses.length>20||statuses.some(value=>!Object.hasOwn(STATES[kind],value)&&value!=='deleted')||new Set(statuses).size!==statuses.length)invalid();
  }
  let situations=null;const situation=get('situation');
  if(situation!==null){
    situations=situation.split(',');
    if(status!==null||!SITUATION_KINDS.includes(kind)||situations.length>50||situations.some(value=>!situationKey(kind,value))||new Set(situations).size!==situations.length)invalid();
  }
  for(const key of ['warehouse_id','product_id','seller_id','component_id','service_id'])if(get(key)!==null&&!UUID.test(get(key)))invalid();
  if(get('service_id')!==null&&kind!=='service_orders')invalid();
  if(get('seller_id')!==null&&!['sales_orders','sales_proposals','service_orders'].includes(kind))invalid();
  if(get('component_id')!==null&&kind!=='sales_orders')invalid();
  const text={};
  for(const [key,[max,kinds]] of Object.entries(LIST_TEXT)){const value=get(key);if(value===null){text[key]=null;continue;}if(!kinds.includes(kind)||!plainText(value,max))invalid();text[key]=value.trim();}
  const state=get('state');if(state!==null&&(!['sales_orders','sales_proposals'].includes(kind)||!DOCUMENT_LIST_UFS.includes(state)))invalid();
  const postal=get('postal_code');if(postal!==null&&(kind!=='sales_orders'||!/^[0-9]{1,8}$/.test(postal)))invalid();
  const template=get('template');if(template!==null&&(kind!=='sales_proposals'||!['true','false'].includes(template)))invalid();
  let lots=null,conditions=null;
  if(get('lote')!==null){if(!['sales_orders','service_orders'].includes(kind))invalid();try{lots=lotCodes(get('lote'));}catch{invalid();}}
  if(get('busca')!==null){try{conditions=parseSearchParam(kind,get('busca'));}catch{invalid();}}
  return {p_limit:Number(limit),p_after:after?.toLowerCase()??null,p_page:paged&&after===null?Number(page??'1'):null,p_order:order,p_statuses:statuses,p_query:query?.trim()||null,
    p_date_type:dateType,p_date_from:from,p_date_to:to,p_warehouse_id:get('warehouse_id')?.toLowerCase()??null,p_product_id:get('product_id')?.toLowerCase()??null,
    p_city:text.city,p_state:state,p_technician:text.technician,p_equipment:text.equipment,p_serial_number:text.serial_number,p_internal_note:text.internal_note,
    // Absent new filters are not sent, so a database still on 095 keeps answering the screens that do not use them.
    ...(postal!==null?{p_postal_code:postal}:{}),...Object.fromEntries(['district','tracking_code','customer_po_number','carrier','contact_email'].filter(key=>text[key]!==null).map(key=>[`p_${key}`,text[key]])),
    ...(template!==null?{p_template:template==='true'}:{}),...(situations!==null?{p_situations:situations}:{}),...(get('seller_id')!==null?{p_seller_id:get('seller_id').toLowerCase()}:{}),
    ...(get('component_id')!==null?{p_component_id:get('component_id').toLowerCase()}:{}),...(get('service_id')!==null?{p_service_id:get('service_id').toLowerCase()}:{}),
    ...(lots?{p_lots:lots}:{}),...(conditions?{p_custom:conditions}:{}),...(origin!==null?{p_origin:origin}:{})};
}
export function documentsRoute(path) {
  const extra = documentExtrasRoute(path);
  if (extra) return extra;
  // 202610200130 Relatórios de vendas e de serviço (read-only).
  const report = documentReportRoute(path);
  if (report) return { kind: report.kind, id: null, action: 'report', report: report.report };
  // 202610200163: situações and transitions of the kind (Gerenciador de transições), for every profile that reads it.
  const situations = /^\/v1\/documentos\/(sales_proposals|sales_orders|purchase_orders|service_orders)\/situacoes$/.exec(path);
  if (situations) return { kind: situations[1], id: null, action: 'situations' };
  // 202610200168: categorias financeiras for the Categoria of pedidos and OS (receita or despesa), for every profile that reads it.
  const categories = /^\/v1\/documentos\/(sales_orders|purchase_orders|service_orders)\/categorias$/.exec(path);
  if (categories) return { kind: categories[1], id: null, action: 'categories' };
  // 202610200169: históricos of the form (cliente, item para o cliente, últimas compras do produto), read-only.
  const history = /^\/v1\/documentos\/(sales_proposals|sales_orders|purchase_orders|service_orders)\/historico$/.exec(path);
  if (history) return { kind: history[1], id: null, action: 'history' };
  // 202610200166: "Exportar para a planilha" with the items (pedidos de compra), read page by page.
  const exported = /^\/v1\/documentos\/(sales_proposals|sales_orders|purchase_orders|service_orders)\/exportacao$/.exec(path);
  if (exported) return { kind: exported[1], id: null, action: 'export' };
  // 202610200167: "Importar › Pedido XML": the draft of a pedido from the XML of an authorized NF-e (nothing is saved).
  const imported = /^\/v1\/documentos\/(sales_orders|purchase_orders)\/importar-xml$/.exec(path);
  if (imported) return { kind: imported[1], id: null, action: 'xml_import' };
  // 202610200196: Formas de pagamento and contas financeiras of the Pagamento section (read-only, the profiles that write the kind).
  const payment = /^\/v1\/documentos\/(sales_proposals|sales_orders|purchase_orders|service_orders)\/pagamento$/.exec(path);
  if (payment) return { kind: payment[1], id: null, action: 'payment_options' };
  // 202610200239 Preferências › Vendas "Situação para aprovação de descontos" (GET for readers of pedidos, POST administrador).
  if (path === '/v1/documentos/sales_orders/aprovacao-descontos') return { kind: 'sales_orders', id: null, action: 'discount_approval' };
  // 202610200199 Assinatura of the proposta (Saudação e Departamento "Definido por usuário"): GET and POST of the user's own.
  if (path === '/v1/documentos/sales_proposals/assinatura') return { kind: 'sales_proposals', id: null, action: 'signature' };
  // 202610200270 "Exibir tipo de cabeçalho: Personalizado": the header of the prints of the kind (GET readers, POST administrador).
  const printHeader = /^\/v1\/documentos\/(sales_proposals|sales_orders|purchase_orders|service_orders)\/cabecalho$/.exec(path);
  if (printHeader) return { kind: printHeader[1], id: null, action: 'print_header' };
  // 202610200197 Sacola de vendas of the user (GET the bag, POST one command: add, set, remove or clear).
  if (path === '/v1/documentos/sacola-vendas') return { kind: null, id: null, action: 'sales_bag' };
  // 202610200196: Código no fornecedor of the products for the fornecedor of the pedido de compra.
  if (path === '/v1/documentos/purchase_orders/codigos-fornecedor') return { kind: 'purchase_orders', id: null, action: 'supplier_codes' };
  // 202610200196: "Gerar venda" / "Gerar ordem de serviço" of a proposta, opened prefilled (nothing is saved).
  const fromProposal = /^\/v1\/documentos\/(sales_orders|service_orders)\/a-partir-da-proposta\/([a-fA-F0-9-]+)$/.exec(path);
  if (fromProposal) return UUID.test(fromProposal[2]) ? { kind: fromProposal[1], id: null, action: 'from_proposal', proposal: fromProposal[2].toLowerCase() } : null;
  // Origin "Pedido de venda - <próximo número>": read-only, never reserves the number (202610200102).
  // 202610200129: POST sets Origin "Próximo número" (administrador, CAS on the number read).
  const next = /^\/v1\/documentos\/(sales_proposals|sales_orders|purchase_orders|service_orders)\/proximo-numero$/.exec(path);
  if (next) return { kind: next[1], id: null, action: 'next_number' };
  // 202610200240: the current structure (Estoque › composições) of the products of a document, for the prints.
  const structure = /^\/v1\/documentos\/(sales_proposals|sales_orders|purchase_orders|service_orders)\/([a-fA-F0-9-]+)\/estrutura$/.exec(path);
  if (structure) return UUID.test(structure[2]) ? { kind: structure[1], id: structure[2].toLowerCase(), action: 'structures' } : null;
  // 202610200131: pendências of a pedido (GET) and "Gerar ordem serviço" from it (POST).
  const salesAction = /^\/v1\/documentos\/sales_orders\/([a-fA-F0-9-]+)\/(pendencias|gerar-os)$/.exec(path);
  if (salesAction) return UUID.test(salesAction[1]) ? { kind: 'sales_orders', id: salesAction[1].toLowerCase(), action: salesAction[2] === 'pendencias' ? 'pendencies' : 'sales_to_service' } : null;
  // 202610200129 Origin "Remover ocorrência": logical removal of one occurrence.
  const removal = /^\/v1\/documentos\/(sales_proposals|sales_orders|purchase_orders|service_orders)\/([a-fA-F0-9-]+)\/ocorrencias\/([a-fA-F0-9-]+)\/exclusao$/.exec(path);
  if (removal) return UUID.test(removal[2]) && UUID.test(removal[3]) ? { kind: removal[1], id: removal[2].toLowerCase(), action: 'occurrence_remove', occurrence: removal[3].toLowerCase() } : null;
  // Origin "Tornar padrão" and "Listagem customizada": the user's own list settings (202610200104).
  const view = /^\/v1\/documentos\/(sales_proposals|sales_orders|service_orders)\/preferencias-listagem$/.exec(path);
  if (view) return { kind: view[1], id: null, action: 'list_view' };
  // 202610200269 Origin "Salvar nova versão" of the proposta.
  const match = /^\/v1\/documentos(?:\/(sales_proposals|sales_orders|purchase_orders|service_orders)(?:\/([a-fA-F0-9-]+)(?:\/(status|convert|ocorrencias|nova-versao))?)?)?$/.exec(path);
  if (!match || (match[2] && !UUID.test(match[2])) || (['convert','nova-versao'].includes(match[3]) && match[1]!=='sales_proposals') || (match[1] && !KINDS.includes(match[1]))) return null;
  return { kind: match[1] || null, id: match[2]?.toLowerCase() || null, action: match[3]==='nova-versao' ? 'proposal_version' : match[3] || null };
}
export function documentsMethods(route) { if (route.extra) return documentExtrasMethods(route); return route.action === 'report' || route.action === 'pendencies' || route.action === 'structures' || route.action === 'situations' || route.action === 'categories' || route.action === 'history' || route.action === 'export'
  || route.action === 'payment_options' || route.action === 'supplier_codes' || route.action === 'from_proposal' ? ['GET'] : route.action === 'sales_bag' || route.action === 'signature' || route.action === 'discount_approval' || route.action === 'print_header' ? ['GET','POST'] : route.action === 'next_number' || route.action === 'ocorrencias' || route.action === 'list_view' ? ['GET','POST'] : route.action ? ['POST'] : route.id ? ['GET','PATCH'] : route.kind ? ['GET','POST'] : ['GET']; }
export const LIST_VIEW_COLUMNS=Object.freeze({sales_orders:['date','contact','total','customer_po_number','address','ship_date','contact_email','contact_phone','contact_document','carrier_name'],sales_proposals:[],service_orders:[]});
function listViewArgs(route,input){
  const statuses=input.default_statuses,columns=input.columns,allowed=LIST_VIEW_COLUMNS[route.kind];
  if(!only(input,['command_id','expected_version','custom_view','columns','default_statuses'])||!UUID.test(input.command_id||'')||!Number.isInteger(input.expected_version)||input.expected_version<0||input.expected_version>2147483647
    ||typeof input.custom_view!=='boolean'||!Array.isArray(columns)||columns.length>8||columns.some(column=>!allowed.includes(column))||new Set(columns).size!==columns.length
    ||(route.kind==='sales_orders'?input.custom_view&&!columns.length:input.custom_view||columns.length>0)
    ||!Array.isArray(statuses)||statuses.length>20||statuses.some(status=>!situationKey(route.kind,status))||new Set(statuses).size!==statuses.length)invalid();
  return {p_kind:route.kind,p_expected_version:input.expected_version,p_command_id:input.command_id.toLowerCase(),p_custom_view:input.custom_view,p_columns:columns,p_default_statuses:statuses};
}
// Origin "Ocorrências" (202610200103): data, hora, texto e, opcionalmente, outra situação (e o próximo contato da proposta).
const OCCURRENCE_ROLES=['admin','consulta','vendas','financeiro','estoque','fiscal','desconhecido'];
const occurrenceText=value=>value===null||(typeof value==='string'&&characters(value)>=1&&characters(value)<=1000&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value));
function occurrenceArgs(route,input){
  const keys=['command_id','expected_version','occurred_on','occurred_time','text','status','next_contact'];
  if(!only(input,keys)||!UUID.test(input.command_id||'')||!Number.isInteger(input.expected_version)||input.expected_version<1||input.expected_version>2147483647
    ||!validDate(input.occurred_on)||typeof input.occurred_time!=='string'||!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(input.occurred_time)
    ||(input.text!==undefined&&input.text!==null&&(typeof input.text!=='string'||!input.text.trim()||!occurrenceText(input.text)))
    ||(input.status!==undefined&&input.status!==null&&!situationKey(route.kind,input.status))
    ||(input.next_contact!==undefined&&input.next_contact!==null&&(route.kind!=='sales_proposals'||!validDate(input.next_contact)))
    ||((input.text??null)===null&&(input.status??null)===null&&(input.next_contact??null)===null))invalid();
  return {p_kind:route.kind,p_document_id:route.id,p_expected_version:input.expected_version,p_command_id:input.command_id.toLowerCase(),p_occurred_on:input.occurred_on,
    p_occurred_time:input.occurred_time,p_text:input.text??null,p_status:input.status??null,p_next_contact:input.next_contact??null};
}
function occurrence(value,kind,documentId){
  if(!object(value)||!UUID.test(value.id||'')||!Number.isInteger(value.sequence)||value.sequence<1||value.sequence>1000000||!validDate(value.occurred_on)
    ||typeof value.occurred_time!=='string'||!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value.occurred_time)||!occurrenceText(value.text)
    ||!Object.hasOwn(STATES[kind],value.status_before)||(value.status_after!==null&&(!Object.hasOwn(STATES[kind],value.status_after)||value.status_after===value.status_before))
    ||(value.next_contact!==null&&(kind!=='sales_proposals'||!validDate(value.next_contact)))||!UUID.test(value.actor_id||'')||!OCCURRENCE_ROLES.includes(value.actor_role)
    ||!Number.isInteger(value.document_version)||value.document_version<1||typeof value.recorded_at!=='string'||value.recorded_at.length>100||!Number.isFinite(Date.parse(value.recorded_at)))badResponse();
  void documentId;
  // 202610200129: the list also names the user (Sistema › Usuários); absent on add results and on a database before 129.
  if(value.actor_name!==undefined&&value.actor_name!==null&&(typeof value.actor_name!=='string'||!value.actor_name||characters(value.actor_name)>120||/[\x00-\x1f\x7f]/.test(value.actor_name)))badResponse();
  // 202610200163: the situação before/after of the moment (absent before 163, null when not recorded).
  const situations=Object.hasOwn(value,'situation_before')?{situation_before:shape(()=>occurrenceSituation(value.situation_before,kind)),situation_after:shape(()=>occurrenceSituation(value.situation_after,kind))}:{};
  return {...picked(value,['id','sequence','occurred_on','occurred_time','text','status_before','status_after','next_contact','actor_id','actor_role','document_version','recorded_at']),...(value.actor_name!==undefined?{actor_name:value.actor_name}:{}),...situations};
}
async function requestBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||'') || !request.body || Number(request.headers.get('content-length'))>262144) invalid();
  const reader=request.body.getReader(); const decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';
  try {
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>262144)invalid();text+=decoder.decode(value,{stream:true});}
    text+=decoder.decode();const input=JSON.parse(text);if(!object(input))invalid();return input;
  } catch { return invalid(); }
  finally { try{await reader.cancel();}catch{/* No request data is logged. */}reader.releaseLock(); }
}
export async function documentsOperation(request,route,params) {
  if(!route)throw new DocumentsError(404,'ERP_NOT_FOUND');
  if(!documentsMethods(route).includes(request.method))throw new DocumentsError(405,'ERP_METHOD_NOT_ALLOWED');
  if(route.extra){try{return await documentExtrasOperation(request,route,params,requestBody);}catch(error){if(error instanceof DocumentExtrasError)throw new DocumentsError(error.status,error.code);throw error;}}
  const args=route.kind?{p_kind:route.kind}:{};
  if(route.action==='report'){try{return documentReportOperation(request,route,params);}catch(error){if(error instanceof DocumentReportError)throw new DocumentsError(error.status,error.code);throw error;}}
  if(request.method==='GET'){
    if(route.action==='next_number'){if(params.size)invalid();return {rpc:'erp_document_next_number',args,type:'next_number'};}
    if(route.action==='ocorrencias'){if(params.size)invalid();return {rpc:'erp_document_occurrence_list',args:{...args,p_document_id:route.id},type:'occurrences'};}
    if(route.action==='pendencies'){if(params.size)invalid();return {rpc:'erp_document_pendencies',args:{...args,p_id:route.id},type:'pendencies'};}
    if(route.action==='structures'){if(params.size)invalid();return {rpc:'erp_document_structures',args:{...args,p_document_id:route.id},type:'structures'};}
    if(route.action==='situations'){if(params.size)invalid();return {rpc:'erp_document_situations',args,type:'situations'};}
    if(route.action==='categories'){if(params.size)invalid();return {rpc:'erp_document_categories',args,type:'categories'};}
    if(route.action==='payment_options'){if(params.size)invalid();return {rpc:'erp_document_payment_options',args,type:'payment_options'};}
    if(route.action==='sales_bag'){if(params.size)invalid();return {rpc:'erp_document_sales_bag',args:{},type:'sales_bag'};}
    if(route.action==='signature'){if(params.size)invalid();return {rpc:'erp_document_signature',args:{},type:'signature'};}
    if(route.action==='print_header'){if(params.size)invalid();return {rpc:'erp_document_print_header',args,type:'print_header'};}
    if(route.action==='discount_approval'){if(params.size)invalid();return {rpc:'erp_document_discount_approval',args:{},type:'discount_approval'};}
    if(route.action==='from_proposal'){if(params.size)invalid();return {rpc:'erp_document_conversion_preview',args:{...args,p_proposal_id:route.proposal},type:'from_proposal'};}
    if(route.action==='supplier_codes'){
      for(const key of params.keys())if(!['contact_id','produtos'].includes(key)||params.getAll(key).length!==1)invalid();
      const contact=params.get('contact_id'),products=(params.get('produtos')??'').split(',');
      if(!UUID.test(contact??'')||!products.length||products.length>250||products.some(id=>!UUID.test(id))||new Set(products.map(id=>id.toLowerCase())).size!==products.length)invalid();
      return {rpc:'erp_document_supplier_codes',args:{p_contact_id:contact.toLowerCase(),p_product_ids:products.map(id=>id.toLowerCase())},type:'supplier_codes'};
    }
    if(route.action==='history'){
      for(const key of params.keys())if(!['contact_id','product_id','q','limit'].includes(key)||params.getAll(key).length!==1)invalid();
      const contact=params.get('contact_id'),product=params.get('product_id'),q=params.get('q'),limit=params.get('limit')??(product?'10':'50');
      if((contact!==null&&!UUID.test(contact))||(product!==null&&!UUID.test(product))||(q!==null&&(characters(q)>120||/[\x00-\x1f\x7f]/.test(q)))
        ||!/^[1-9][0-9]?$/.test(limit)||Number(limit)>50||(route.kind==='purchase_orders'?product===null:contact===null))invalid();
      return {rpc:'erp_document_history',args:{...args,p_contact_id:contact?.toLowerCase()??null,p_product_id:product?.toLowerCase()??null,p_query:q,p_limit:Number(limit)},type:'history'};
    }
    if(route.action==='export'){
      for(const key of params.keys())if(!['from','to','page'].includes(key)||params.getAll(key).length!==1)invalid();
      const from=params.get('from'),to=params.get('to'),page=params.get('page')??'1';
      if(!validDate(from)||!validDate(to)||from>to||(Date.parse(`${to}T00:00:00Z`)-Date.parse(`${from}T00:00:00Z`))/86400000>366||!/^[1-9][0-9]{0,2}$/.test(page)||Number(page)>200)invalid();
      return {rpc:'erp_document_export',args:{...args,p_date_from:from,p_date_to:to,p_page:Number(page)},type:'export'};
    }
    if(route.action==='list_view'){if(params.size)invalid();return {rpc:'erp_document_list_view_get',args,type:'list_view'};}
    if(!route.kind||route.id){if(params.size)invalid();return {rpc:route.id?'erp_document_get':'erp_document_access',args:{...args,...(route.id?{p_id:route.id}:{})},type:route.id?'document':'access'};}
    return {rpc:'erp_document_list',args:{...args,...listArgs(route.kind,params)},type:'list'};
  }
  if(params.size)invalid();
  if(route.action==='xml_import'){
    // The body (up to 2 MB) is read and the XML parsed only by `prepare`, which the API runs after the session is
    // authenticated: an anonymous request never makes the Worker read or parse the XML.
    const operation={rpc:'erp_document_xml_match',args:{...args},type:'xml_import',draft:null,prepare:async()=>{
      const xml=await xmlBody(request);if(xml===null)invalid();
      const draft=xmlDraft(route.kind,xml);
      if(draft.refused)throw new DocumentsError(422,`ERP_${draft.refused.toUpperCase()}`);
      const document=draft.party.document&&/^(\d{11}|\d{14})$/.test(draft.party.document)?draft.party.document:null;
      operation.draft=draft;Object.assign(operation.args,{p_document:document,p_items:draft.items.map(item=>({code:item.code,gtin:item.gtin}))});
    }};
    return operation;
  }
  const input=await requestBody(request);
  if(route.action==='next_number'){
    if(!only(input,['command_id','expected_next_number','next_number'])||!UUID.test(input.command_id||'')||!documentNumber(input.expected_next_number)||!documentNumber(input.next_number))invalid();
    return {rpc:'erp_document_numbering_set',args:{...args,p_command_id:input.command_id.toLowerCase(),p_expected_next_number:input.expected_next_number,p_next_number:input.next_number},type:'next_number'};
  }
  if(route.action==='print_header'){
    if(!only(input,['command_id','expected_version','content'])||!UUID.test(input.command_id||'')||!Number.isInteger(input.expected_version)||input.expected_version<0||input.expected_version>2147483646)invalid();
    let content;try{content=normalizeRichText(input.content);}catch{return invalid();}
    return {rpc:'erp_document_print_header_save',args:{p_kind:route.kind,p_command_id:input.command_id.toLowerCase(),p_expected_version:input.expected_version,p_content:content},type:'print_header'};
  }
  if(route.action==='signature'){
    const line=(value,max)=>value===null||(typeof value==='string'&&characters(value)<=max&&!/[\u0000-\u001f\u007f]/.test(value));
    if(!only(input,['command_id','expected_version','greeting','department'])||!UUID.test(input.command_id||'')||!Number.isInteger(input.expected_version)||input.expected_version<0||input.expected_version>2147483646
      ||!line(input.greeting,200)||!line(input.department,100))invalid();
    return {rpc:'erp_document_signature_save',args:{p_command_id:input.command_id.toLowerCase(),p_expected_version:input.expected_version,p_greeting:input.greeting,p_department:input.department},type:'signature'};
  }
  if(route.action==='discount_approval'){
    const ids=input.situations;
    if(!only(input,['command_id','expected_version','situations'])||!UUID.test(input.command_id||'')||!Number.isInteger(input.expected_version)||input.expected_version<0||input.expected_version>2147483646
      ||!Array.isArray(ids)||ids.length>5||ids.some(id=>typeof id!=='string'||!UUID.test(id))||new Set(ids.map(id=>id.toLowerCase())).size!==ids.length)invalid();
    return {rpc:'erp_document_discount_approval_save',args:{p_command_id:input.command_id.toLowerCase(),p_expected_version:input.expected_version,p_situations:ids.map(id=>id.toLowerCase())},type:'discount_approval'};
  }
  if(route.action==='sales_bag'){
    const action=input.action,quantity=input.quantity;
    if(!only(input,['command_id','action','product_id','quantity'])||!UUID.test(input.command_id||'')||!['add','set','remove','clear'].includes(action)
      ||(action==='clear'?input.product_id!==undefined:!UUID.test(input.product_id||''))
      ||(['add','set'].includes(action)?typeof quantity!=='string'||!/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,6})?$/.test(quantity)||/^0(\.0+)?$/.test(quantity):quantity!==undefined))invalid();
    return {rpc:'erp_document_sales_bag_change',args:{p_command_id:input.command_id.toLowerCase(),p_action:action,p_product_id:input.product_id?.toLowerCase()??null,p_quantity:quantity??null},type:'sales_bag'};
  }
  if(route.action==='sales_to_service'){
    if(!only(input,['command_id','expected_version'])||!UUID.test(input.command_id||'')||!Number.isInteger(input.expected_version)||input.expected_version<1||input.expected_version>2147483647)invalid();
    return {rpc:'erp_sales_order_convert_to_service',args:{p_id:route.id,p_expected_version:input.expected_version,p_command_id:input.command_id.toLowerCase()},type:'sales_to_service'};
  }
  if(route.action==='occurrence_remove'){
    if(!only(input,['command_id'])||!UUID.test(input.command_id||''))invalid();
    return {rpc:'erp_document_occurrence_remove',args:{...args,p_document_id:route.id,p_occurrence_id:route.occurrence,p_command_id:input.command_id.toLowerCase()},type:'occurrence_remove'};
  }
  if(route.action==='ocorrencias')return {rpc:'erp_document_occurrence_add',args:occurrenceArgs(route,input),type:'occurrence'};
  if(route.action==='list_view')return {rpc:'erp_document_list_view_save',args:listViewArgs(route,input),type:'list_view'};
  if(route.action==='proposal_version'){
    if(!only(input,['command_id','expected_version','data'])||!UUID.test(input.command_id||'')||!Number.isInteger(input.expected_version)||input.expected_version<1||input.expected_version>2147483647
      ||!object(input.data)||Object.hasOwn(input.data,'number')||input.data.template===true)invalid();
    try{normalizeDocument('sales_proposals',input.data);}catch{return invalid();}
    return {rpc:'erp_document_proposal_version',args:{p_id:route.id,p_expected_version:input.expected_version,p_command_id:input.command_id.toLowerCase(),p_body:input.data},type:'document'};
  }
  // 202610200196: a new pedido/OS may carry the proposta it comes from (Gerar venda / Gerar ordem de serviço opened prefilled).
  const allowed=route.action==='convert'?['command_id','expected_version']:route.action==='status'?['command_id','expected_version','status','reason']:route.id?['command_id','expected_version','data']
    :['sales_orders','service_orders'].includes(route.kind)?['command_id','data','source_proposal']:['command_id','data'];
  if(!only(input,allowed)||!UUID.test(input.command_id||'')||(route.id&&(!Number.isInteger(input.expected_version)||input.expected_version<1||input.expected_version>2147483647)))invalid();
  const base={...args,p_id:route.id,p_expected_version:route.id?input.expected_version:0,p_command_id:input.command_id};
  if(route.action==='convert')return {rpc:'erp_proposal_convert',args:{p_id:route.id,p_expected_version:input.expected_version,p_command_id:input.command_id},type:'conversion'};
  if(route.action==='status'){
    if(!situationKey(route.kind,input.status)|| (input.reason!==undefined && input.reason!==null && (typeof input.reason!=='string'||input.reason.length>1000||/[\x00-\x1f\x7f]/.test(input.reason))))invalid();
    return {rpc:'erp_document_transition',args:{...base,p_status:input.status,p_reason:input.reason??null},type:'document'};
  }
  try{normalizeDocument(route.kind,input.data);}catch{return invalid();}
  if(input.source_proposal!==undefined){
    const source=input.source_proposal;
    if(!only(source,['id','expected_version'])||!UUID.test(source.id||'')||!Number.isInteger(source.expected_version)||source.expected_version<1||source.expected_version>2147483647)invalid();
    return {rpc:'erp_document_save',args:{...base,p_body:{...input.data,source_proposal:{id:source.id.toLowerCase(),expected_version:source.expected_version}}},type:'document',source_proposal:source.id.toLowerCase()};
  }
  return {rpc:'erp_document_save',args:{...base,p_body:input.data},type:'document'};
}
const decimals=value=>Number.isInteger(value)&&value>=0&&value<=10;
const money=value=>typeof value==='string'&&/^(0|[1-9][0-9]{0,11})\.[0-9]{2}$/.test(value);
const nullableText=(value,max)=>value===null||(typeof value==='string'&&characters(value)<=max);
// 202610200168: categorias of the seletor (receita for vendas and OS, despesa for compras), in tree order, at most 500.
function categoriesPage(value,kind){
  const expected=kind==='purchase_orders'?'payable':'receivable',name=text=>typeof text==='string'&&text.trim()!==''&&characters(text)<=200;
  if(!object(value)||value.kind!==kind||value.category_kind!==expected||!Array.isArray(value.items)||value.items.length>500||!Number.isSafeInteger(value.total_count)||value.total_count<value.items.length
    ||(value.default!==null&&(!object(value.default)||!UUID.test(value.default.id||'')||!name(value.default.name))))badResponse();
  const ids=new Set();
  const items=value.items.map(item=>{
    if(!object(item)||!UUID.test(item.id||'')||ids.has(item.id)||!name(item.name)||(item.parent_id!==null&&!UUID.test(item.parent_id||''))
      ||!Number.isInteger(item.depth)||item.depth<1||item.depth>5||(item.depth===1)!==(item.parent_id===null))badResponse();
    ids.add(item.id);return {id:item.id,name:item.name,parent_id:item.parent_id,depth:item.depth};
  });
  return {kind,category_kind:expected,items,total_count:value.total_count,has_more:value.total_count>items.length,default:value.default===null?null:{id:value.default.id,name:value.default.name}};
}
// 202610200169: one history (items of pedidos and, for administrador and fiscal, of notas) and the open receivables of the cliente.
function historyPage(value,kind,args){
  // 202610200239: the purchases of a product also list the manual stock entries (type stock, no number).
  const purchase=kind==='purchase_orders',types=purchase?['purchase','invoice','stock']:['sale','invoice'];
  const text=(v,max,empty=true)=>typeof v==='string'&&characters(v)<=max&&(empty||v.trim()!=='');
  if(!object(value)||value.kind!==kind||value.contact_id!==args.p_contact_id||value.product_id!==args.p_product_id||!Array.isArray(value.items)||value.items.length>args.p_limit
    ||typeof value.has_more!=='boolean'||typeof value.invoices_included!=='boolean')badResponse();
  const items=value.items.map(item=>{
    if(!object(item)||!types.includes(item.type)||(item.type==='invoice'&&!value.invoices_included)||(item.type==='stock'&&(args.p_contact_id!==null||args.p_product_id===null))||!UUID.test(item.document_id||'')
      ||(item.type==='stock'?item.number!==null:!documentNumber(item.number))||!validDate(item.date)
      ||!Number.isInteger(item.position)||item.position<1||item.position>990||!text(item.description,200)||(item.code!==null&&!text(item.code,100))||!text(item.unit,16)
      ||(item.product_id!==null&&!UUID.test(item.product_id))||(args.p_product_id!==null&&item.product_id!==args.p_product_id)
      ||typeof item.quantity!=='string'||!/^(0|[1-9][0-9]{0,17})\.[0-9]{6}$/.test(item.quantity)||/^0\.0+$/.test(item.quantity)||!isCanonicalUnitPrice(item.unit_price,14))badResponse();
    return picked(item,['type','document_id','number','date','position','description','code','product_id','unit','quantity','unit_price']);
  });
  let finance=null;
  // 202610200239: the Financeiro tab of the OS without "Histórico financeiro" comes hidden.
  const hidden=value.finance_hidden===true;
  if(value.finance_hidden!==undefined&&(!hidden||kind!=='service_orders'||args.p_product_id!==null||value.finance!==null))badResponse();
  if(purchase||args.p_product_id!==null||hidden){if(value.finance!==null)badResponse();}
  else{
    const f=value.finance;
    if(!object(f)||!Number.isSafeInteger(f.open_count)||f.open_count<0||!money(f.open_amount)||!money(f.overdue_amount)||!Array.isArray(f.titles)||f.titles.length>20||f.titles.length>f.open_count)badResponse();
    finance={open_count:f.open_count,open_amount:f.open_amount,overdue_amount:f.overdue_amount,titles:f.titles.map(t=>{
      if(!object(t)||!UUID.test(t.id||'')||!validDate(t.due_on)||!text(t.description,200)||!Number.isInteger(t.installment)||!Number.isInteger(t.installments)||t.installment<1||t.installment>t.installments||t.installments>120
        ||!money(t.amount)||!money(t.open_amount))badResponse();
      return picked(t,['id','due_on','description','installment','installments','amount','open_amount']);
    })};
  }
  return {kind,contact_id:args.p_contact_id,product_id:args.p_product_id,items,has_more:value.has_more,invoices_included:value.invoices_included,finance,...(hidden?{finance_hidden:true}:{})};
}
// 202610200166: one page of the export (25 documents with their items); every field is checked.
function exportPage(value,kind,args){
  if(!object(value)||value.kind!==kind||value.date_from!==args.p_date_from||value.date_to!==args.p_date_to||value.page!==args.p_page||value.size!==25||!Number.isSafeInteger(value.total_count)||value.total_count<0||value.total_count>5000
    ||typeof value.has_more!=='boolean'||value.has_more!==(args.p_page*25<value.total_count)||!Array.isArray(value.items)||value.items.length>25
    ||value.items.length!==Math.max(0,Math.min(25,value.total_count-(args.p_page-1)*25)))badResponse();
  const items=value.items.map(doc=>{
    if(!object(doc)||!UUID.test(doc.id||'')||!documentNumber(doc.number)||!validDate(doc.date)||(doc.expected_date!==null&&!validDate(doc.expected_date))||!Object.hasOwn(STATES[kind],doc.status)
      ||!nullableText(doc.situation_name,40)||typeof doc.contact_name!=='string'||characters(doc.contact_name)>200||!nullableText(doc.contact_document,30)||!nullableText(doc.order_reference,100)
      ||!nullableText(doc.internal_notes,4000)||!money(doc.freight)||!money(doc.discount)||!money(doc.total)||!Array.isArray(doc.items)||doc.items.length>250)badResponse();
    const lines=doc.items.map((line,index)=>{
      if(!object(line)||line.position!==index+1||!nullableText(line.code,100)||typeof line.description!=='string'||characters(line.description)>200||typeof line.unit!=='string'||characters(line.unit)>16
        ||typeof line.quantity!=='string'||!/^(0|[1-9][0-9]{0,8})\.[0-9]{6}$/.test(line.quantity)||!isCanonicalUnitPrice(line.unit_price,10)
        ||typeof line.discount_percent!=='string'||!/^(0|[1-9][0-9]{0,2})\.[0-9]{4}$/.test(line.discount_percent)||!money(line.total))badResponse();
      return picked(line,['position','code','description','unit','quantity','unit_price','discount_percent','total']);
    });
    return {...picked(doc,['id','number','date','expected_date','status','situation_name','contact_name','contact_document','order_reference','internal_notes','freight','discount','total']),items:lines};
  });
  if(new Set(items.map(item=>item.id)).size!==items.length)badResponse();
  return {kind,date_from:value.date_from,date_to:value.date_to,page:value.page,size:25,total_count:value.total_count,has_more:value.has_more,items};
}
const sellerName=(value,id)=>{if(value===null)return null;if(id===null||typeof value!=='string'||!value||characters(value)>200)badResponse();return value;};
function accessSettings(value){
  const auto=value?.auto_products,warehouse=value?.default_warehouse;
  // 202610200199 adds weight_decimals (Preferências › Empresa "Número de casas decimais no peso do produto", 0 to 5).
  // 202610200287 adds quantity_decimals ("Número de casas decimais na quantidade", 0 to 6: the quantities keep at most 6).
  const weight=Object.hasOwn(value??{},'weight_decimals'),quantity=Object.hasOwn(value??{},'quantity_decimals');
  if(!only(value,['price_decimals_out','price_decimals_in','weight_decimals','quantity_decimals','cross_docking_days','occurrence_date_editable','stock_launch_date','auto_products','default_warehouse'])||Object.keys(value).length!==7+(weight?1:0)+(quantity?1:0)
    ||(weight&&(!Number.isInteger(value.weight_decimals)||value.weight_decimals<0||value.weight_decimals>5))||(quantity&&(!Number.isInteger(value.quantity_decimals)||value.quantity_decimals<0||value.quantity_decimals>6))||!['data_atual','data_documento'].includes(value.stock_launch_date)
    ||!decimals(value.price_decimals_out)||!decimals(value.price_decimals_in)||!Number.isInteger(value.cross_docking_days)||value.cross_docking_days<0||value.cross_docking_days>9999
    ||typeof value.occurrence_date_editable!=='boolean'||!only(auto,['sales','purchases','services'])||Object.keys(auto).length!==3||Object.values(auto).some(flag=>typeof flag!=='boolean')
    ||(warehouse!==null&&(!only(warehouse,['id','name'])||!UUID.test(warehouse.id||'')||typeof warehouse.name!=='string'||!warehouse.name||characters(warehouse.name)>200)))badResponse();
  return {price_decimals_out:value.price_decimals_out,price_decimals_in:value.price_decimals_in,...(weight?{weight_decimals:value.weight_decimals}:{}),...(quantity?{quantity_decimals:value.quantity_decimals}:{}),cross_docking_days:value.cross_docking_days,occurrence_date_editable:value.occurrence_date_editable,stock_launch_date:value.stock_launch_date,
    auto_products:{sales:auto.sales,purchases:auto.purchases,services:auto.services},default_warehouse:warehouse===null?null:{id:warehouse.id,name:warehouse.name}};
}
function accessSeller(value){
  if(value===null)return null;
  if(!only(value,['id','name','allow_unregistered_products','view_stock','discount_limit'])||Object.keys(value).length!==5||!UUID.test(value.id||'')||typeof value.name!=='string'||!value.name||characters(value.name)>200
    ||typeof value.allow_unregistered_products!=='boolean'||typeof value.view_stock!=='boolean'||typeof value.discount_limit!=='string'||!/^(0|[1-9][0-9]{0,2})\.[0-9]{4}$/.test(value.discount_limit)||Number(value.discount_limit)>100)badResponse();
  return {id:value.id,name:value.name,allow_unregistered_products:value.allow_unregistered_products,view_stock:value.view_stock,discount_limit:value.discount_limit};
}
function snapshot(value,expectedId,contact) {
  if(expectedId===null){if(value!==null&&value!==undefined)badResponse();return null;}
  if(!object(value)||value.id!==expectedId||!Number.isInteger(value.version)||value.version<1)badResponse();
  // 202610200129: GTIN, GTIN tributário, NCM, localização and peso bruto of the product, for the Preferências print options and "Somar peso bruto".
  const fields=contact?{name:200,code:100,document:30,trade_name:200,email:254,phone:40,mobile:40,street:200,number:30,complement:200,district:100,city:100,state:2,postal_code:20}:{name:200,code:100,unit:16,price:25,kind:1,format:1,gtin:14,gtin_tax:14,ncm:10,location:100,gross_weight:25};
  const safe={id:expectedId,version:value.version};
  for(const [key,max]of Object.entries(fields)){const v=value[key]??null;if(v!==null&&(typeof v!=='string'||v.length>max))badResponse();safe[key]=v;}
  if(typeof safe.name!=='string'||!safe.name||!contact&&safe.price!==null&&!isCanonicalUnitPrice(safe.price,14)||!contact&&safe.gross_weight!==null&&!/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/.test(safe.gross_weight))badResponse();return safe;
}
function metadata(value,kind) {
  if(!object(value)||value.kind!==kind||!UUID.test(value.id||'')||!Number.isInteger(value.version)||value.version<1||value.version>2147483647
    ||typeof value.number!=='string'||!/^[1-9][0-9]{0,9}$/.test(value.number)||!Object.hasOwn(STATES[kind],value.status))badResponse();
  const meta=picked(value,['id','kind','version','number','status']);
  for(const key of ['created_at','updated_at']){if(typeof value[key]!=='string'||value[key].length>100||!Number.isFinite(Date.parse(value[key])))badResponse();meta[key]=value[key];}
  return meta;
}
function summary(value,kind) {
  // 202610220009: a document of Origin origin converted to the native model (authority brufap) is read as a native one.
  if(value?.authority==='origin')return shape(()=>documentMirrorSummary(value,kind));
  const meta=metadata(value,kind);
  if(typeof value.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value.date)||typeof value.total!=='string'||!/^\d{1,12}\.\d{2}$/.test(value.total)
    ||typeof value.contact_name!=='string'||characters(value.contact_name)>200||!UUID.test(value.contact_id||''))badResponse();
  const optionalDate=key=>{const v=value[key];if(v!==null&&!validDate(v))badResponse();return v;};
  const optionalText=(key,max)=>{const v=value[key];if(v!==null&&(typeof v!=='string'||characters(v)>max))badResponse();return v;};
  const flag=key=>{if(typeof value[key]!=='boolean')badResponse();return value[key];};
  const source=value.source_proposal_id,sourceNumber=value.source_proposal_number;
  if(source===null?sourceNumber!==null:(!UUID.test(source||'')||!['sales_orders','service_orders'].includes(kind)||typeof sourceNumber!=='string'||!/^[1-9][0-9]{0,9}$/.test(sourceNumber)))badResponse();
  if((value.warehouse_id!==null&&!UUID.test(value.warehouse_id||''))||(value.warehouse_id===null&&value.warehouse_name!==null)||(value.fiscal_draft!==null&&(typeof value.fiscal_draft!=='boolean'||kind!=='sales_orders')))badResponse();
  const row={...meta,date:value.date,total:value.total,contact_id:value.contact_id,contact_name:value.contact_name,
    expected_date:optionalDate('expected_date'),next_contact:optionalDate('next_contact'),template:flag('template'),
    warehouse_id:value.warehouse_id,warehouse_name:optionalText('warehouse_name',200),source_proposal_id:source,source_proposal_number:sourceNumber,
    finance_active:flag('finance_active'),stock_active:flag('stock_active'),receipt_active:flag('receipt_active'),reservation_active:value.reservation_active===null?null:flag('reservation_active'),
    fiscal_draft:value.fiscal_draft,internal_notes:optionalText('internal_notes',280),
    // 018: N and C of what was done in the Origin (converted documents); a database before 018 does not send them.
    origin_finance:value.origin_finance===undefined?false:flag('origin_finance'),origin_invoice:value.origin_invoice===undefined?false:flag('origin_invoice')};
  if((row.receipt_active&&kind!=='purchase_orders')||(row.reservation_active&&kind!=='sales_orders')||(row.template&&kind!=='sales_proposals'))badResponse();
  // 202610200102 columns; a database still on 095 does not send them and the row keeps its previous shape.
  if(Object.hasOwn(value,'first_sale')){
    const extra={customer_po_number:optionalText('customer_po_number',60),ship_date:optionalDate('ship_date'),contact_email:optionalText('contact_email',254),contact_phone:optionalText('contact_phone',40),
      contact_document:optionalText('contact_document',30),address:optionalText('address',500),carrier_name:optionalText('carrier_name',200),first_sale:flag('first_sale')};
    if(extra.first_sale&&kind!=='sales_orders')badResponse();
    Object.assign(row,extra);
  }
  // 202610200131: nota fiscal de origem, pendências and the OS generated from the pedido (absent before 131).
  if(Object.hasOwn(value,'pendencies')){
    const invoice=value.invoice,os=value.service_order_number;
    // 202610200198: the ordem de serviço carries its nota too.
    if(typeof value.pendencies!=='boolean'||(value.pendencies&&kind!=='sales_orders')||(os!==null&&(kind!=='sales_orders'||!documentNumber(os)))
      ||(invoice!==null&&(!['sales_orders','service_orders'].includes(kind)||!object(invoice)||!['55','65'].includes(invoice.model)||(invoice.number!==null&&!/^[1-9][0-9]{0,8}$/.test(invoice.number))
        ||typeof invoice.series!=='string'||!/^[0-9]{1,3}$/.test(invoice.series)||!validDate(invoice.issue_date)||typeof invoice.authorized!=='boolean')))badResponse();
    if(value.template_name!==null&&(kind!=='sales_proposals'||typeof value.template_name!=='string'||characters(value.template_name)>120))badResponse();
    Object.assign(row,{invoice:invoice===null?null:{model:invoice.model,number:invoice.number,series:invoice.series,issue_date:invoice.issue_date,authorized:invoice.authorized},pendencies:value.pendencies,service_order_number:os,template_name:value.template_name});
  }
  // 202610200163: situação of the Gerenciador de transições and the "nota vinculada" flag of every profile.
  if(Object.hasOwn(value,'situation')){
    if(typeof value.invoice_linked!=='boolean'||(value.invoice_linked&&!['sales_orders','service_orders'].includes(kind))||(row.invoice&&!value.invoice_linked))badResponse();
    Object.assign(row,{situation:shape(()=>situationValue(value.situation,kind,row.status)),invoice_linked:value.invoice_linked});
  }
  // 202610200164: native vendedor (absent before 164).
  if(Object.hasOwn(value,'seller_id')){
    if((value.seller_id!==null&&(!UUID.test(value.seller_id)||kind==='purchase_orders'))||(value.seller_id===null&&value.seller_name!==null))badResponse();
    Object.assign(row,{seller_id:value.seller_id,seller_name:optionalText('seller_name',200)});
  }
  // 202610200269: the version of the proposta ("123-2"), absent before 269.
  if(Object.hasOwn(value,'version_label')){
    if(value.version_label!==null&&(kind!=='sales_proposals'||typeof value.version_label!=='string'||!/^[1-9][0-9]{0,9}-[1-9][0-9]{0,3}$/.test(value.version_label)))badResponse();
    row.version_label=value.version_label;
  }
  if(Object.hasOwn(value,'origin')){if(!['brufap','origin'].includes(value.origin)||value.authority!=='brufap'||value.readonly!==false)badResponse();Object.assign(row,{origin:value.origin,authority:'brufap',readonly:false});}
  return row;
}
/** 202610200269: versions of a proposta (null without other versions). */
export function proposalVersion(value){
  if(value===null)return null;
  const label=v=>typeof v==='string'&&/^[1-9][0-9]{0,9}(-[1-9][0-9]{0,3})?$/.test(v);
  if(!only(value,['base_id','base_number','seq','label','versions','superseded','latest'])||!UUID.test(value.base_id||'')||!documentNumber(value.base_number)||!Number.isInteger(value.seq)||value.seq<1||value.seq>9999
    ||value.label!==(value.seq===1?value.base_number:`${value.base_number}-${value.seq}`)||!Number.isInteger(value.versions)||value.versions<2||value.versions>9999||typeof value.superseded!=='boolean'
    ||!only(value.latest,['id','label'])||!UUID.test(value.latest?.id||'')||!label(value.latest.label)||(value.superseded===(value.latest.label===value.label)))badResponse();
  return {base_id:value.base_id,base_number:value.base_number,seq:value.seq,label:value.label,versions:value.versions,superseded:value.superseded,latest:{id:value.latest.id,label:value.latest.label}};
}
function document(value,kind) {
  if(value?.authority==='origin')return shape(()=>documentMirrorRecord(value,kind));
  const meta=metadata(value,kind);if(!Array.isArray(value.items)||!Array.isArray(value.installments))badResponse();
  // 016: origin_finance/origin_invoice, the Origin effects (contas lançadas, nota gerada) that lock a converted document like the native ones.
  if(!only(value.effect_flags,['finance_active','stock_active','origin_finance','origin_invoice'])||typeof value.effect_flags.finance_active!=='boolean'||typeof value.effect_flags.stock_active!=='boolean'
    ||['origin_finance','origin_invoice'].some(key=>value.effect_flags[key]!==undefined&&typeof value.effect_flags[key]!=='boolean'))badResponse();
  const input=picked(value,INPUT_FIELDS);input.items=value.items.map(item=>object(item)?picked(item,ITEM_FIELDS):null);
  input.installments=value.installments.map(row=>object(row)?picked(row,INSTALLMENT_FIELDS):null);
  let normalized;try{normalized=normalizeDocument(kind,input);}catch{return badResponse();}
  // 202610200270: also the Total outros itens of the proposta.
  if(!object(value.totals)||[...TOTAL_FIELDS,'ipi','icms_st','other_items'].some(key=>value.totals[key]!==normalized.totals[key]))badResponse();
  const seen=new Set();
  normalized.items=normalized.items.map((item,index)=>{
    const actual=value.items[index];if(!UUID.test(item.id||'')||seen.has(item.id)||actual.position!==item.position||!isCanonicalUnitPrice(actual.unit_price,10)||['gross','discount','total'].some(key=>actual[key]!==item[key]))badResponse();seen.add(item.id);
    return {...item,product_snapshot:snapshot(actual.product_snapshot,item.product_id,false)};
  });
  if(value.source_proposal_id!==null&&value.source_proposal_id!==undefined&&(typeof value.source_proposal_id!=='string'||!UUID.test(value.source_proposal_id)||!['sales_orders','service_orders'].includes(kind)))badResponse();
  if(Object.hasOwn(value,'origin')&&(!['brufap','origin'].includes(value.origin)||value.authority!=='brufap'||value.readonly!==false))badResponse();
  return {...normalized,...meta,...(Object.hasOwn(value,'origin')?{origin:value.origin,authority:'brufap',readonly:false}:{}),effect_flags:{finance_active:value.effect_flags.finance_active,stock_active:value.effect_flags.stock_active,origin_finance:value.effect_flags.origin_finance===true,origin_invoice:value.effect_flags.origin_invoice===true},contact_snapshot:snapshot(value.contact_snapshot,normalized.contact_id,true),source_proposal_id:value.source_proposal_id??null,
    // 202610200163 reads carry the situação and the name of the native vendedor (the save result and a database before 163 do not).
    ...(Object.hasOwn(value,'situation')?{situation:shape(()=>situationValue(value.situation,kind,meta.status))}:{}),
    ...(Object.hasOwn(value,'seller_name')?{seller_name:sellerName(value.seller_name,normalized.seller_id??null)}:{}),
    // 202610200168 reads also name the categoria and the transportador of the cadastro.
    ...(Object.hasOwn(value,'category_name')?{category_name:sellerName(value.category_name,normalized.category_id??null)}:{}),
    ...(Object.hasOwn(value,'carrier_name')?{carrier_name:sellerName(value.carrier_name,normalized.carrier_id??null)}:{}),
    // 202610200196 reads name the Lista de preço, the Destino and the Formas / contas of the parcelas.
    ...(Object.hasOwn(value,'price_list_name')?{price_list_name:sellerName(value.price_list_name,normalized.price_list_id??null)}:{}),
    ...(Object.hasOwn(value,'payment_account_name')?{payment_account_name:sellerName(value.payment_account_name,normalized.payment_account_id??null)}:{}),
    ...(Object.hasOwn(value,'payment_method_names')?{payment_method_names:nameMap(value.payment_method_names,normalized.installments.map(row=>row.payment_method_id??null),100)}:{}),
    ...(Object.hasOwn(value,'payment_account_names')?{payment_account_names:nameMap(value.payment_account_names,normalized.installments.map(row=>row.details?.account_id??null),200)}:{}),
    // 202610200269 reads of a proposta carry its versions.
    ...(Object.hasOwn(value,'proposal_version')?{proposal_version:kind==='sales_proposals'?proposalVersion(value.proposal_version):badResponse()}:{})};
}
// Names of the ids referenced by the parcelas (an id no longer in the cadastro has no name).
function nameMap(value,ids,max){
  const known=new Set(ids.filter(Boolean));
  if(!object(value)||Object.keys(value).length>known.size||Object.entries(value).some(([id,name])=>!known.has(id)||typeof name!=='string'||!name||characters(name)>max))badResponse();
  return Object.fromEntries(Object.entries(value).map(([id,name])=>[id,name]));
}
// 202610200196: the automatic lançamento de contas (Preferências › Vendas › Vendas) of a save or of a change of situação.
function autoFinance(value){
  if(!object(value)||!['done','skipped'].includes(value.outcome))badResponse();
  if(value.outcome==='done'){if(!only(value,['outcome','posting_id'])||!UUID.test(value.posting_id||''))badResponse();return {outcome:'done',posting_id:value.posting_id};}
  if(!only(value,['outcome','reason'])||typeof value.reason!=='string'||!/^erp_[a-z0-9_]{1,80}$/.test(value.reason))badResponse();
  return {outcome:'skipped',reason:value.reason};
}
const PAYMENT_DESTINATIONS=['contas','ficha','caixa'];
function paymentOptions(value,kind){
  if(!object(value)||value.kind!==kind||!Array.isArray(value.methods)||value.methods.length>200||!Array.isArray(value.accounts)||value.accounts.length>200||(kind==='sales_proposals'&&value.accounts.length))badResponse();
  const methods=value.methods.map(m=>{
    if(!only(m,['id','description','payment_type','condition','destination','account_id','card_brand','card_integration','card_cnpj','is_default'])||Object.keys(m).length!==10||!UUID.test(m.id||'')
      ||typeof m.description!=='string'||!m.description||characters(m.description)>100||!PAYMENT_TYPES.includes(m.payment_type)||(m.condition!==null&&(typeof m.condition!=='string'||characters(m.condition)>100))
      ||!PAYMENT_DESTINATIONS.includes(m.destination)||(m.account_id!==null&&!UUID.test(m.account_id))||(m.card_brand!==null&&!CARD_BRANDS.includes(m.card_brand))
      ||(m.card_integration!==null&&!['1','2'].includes(m.card_integration))||(m.card_cnpj!==null&&(typeof m.card_cnpj!=='string'||!/^[A-Z0-9]{12}[0-9]{2}$/.test(m.card_cnpj)))||typeof m.is_default!=='boolean')badResponse();
    return picked(m,['id','description','payment_type','condition','destination','account_id','card_brand','card_integration','card_cnpj','is_default']);
  });
  const accounts=value.accounts.map(a=>{
    if(!only(a,['id','name','kind'])||!UUID.test(a.id||'')||typeof a.name!=='string'||!a.name||characters(a.name)>200||!['bank','cash','other'].includes(a.kind))badResponse();
    return {id:a.id,name:a.name,kind:a.kind};
  });
  if(new Set(methods.map(m=>m.id)).size!==methods.length||new Set(accounts.map(a=>a.id)).size!==accounts.length)badResponse();
  return {kind,methods,accounts};
}
// 202610200197: the Sacola de vendas of the user (at most 250 products) and the receipt of a change.
function salesBag(value,operation){
  const change=operation.rpc==='erp_document_sales_bag_change';
  if(!object(value)||!Array.isArray(value.items)||value.items.length>250||value.count!==value.items.length||value.limit!==250
    ||(change&&(value.action!==operation.args.p_action||value.product_id!==operation.args.p_product_id||typeof value.replayed!=='boolean')))badResponse();
  const items=value.items.map(item=>{
    if(!only(item,['product_id','name','code','unit','price','quantity','active','kind'])||!UUID.test(item.product_id||'')||typeof item.name!=='string'||!item.name||characters(item.name)>200
      ||(item.code!==null&&(typeof item.code!=='string'||characters(item.code)>100))||(item.unit!==null&&(typeof item.unit!=='string'||characters(item.unit)>16))||(item.price!==null&&!isCanonicalUnitPrice(item.price,10))
      ||typeof item.quantity!=='string'||!/^(0|[1-9][0-9]{0,8})\.[0-9]{6}$/.test(item.quantity)||/^0\.0+$/.test(item.quantity)||typeof item.active!=='boolean'||(item.kind!==null&&!['P','S','N'].includes(item.kind)))badResponse();
    return picked(item,['product_id','name','code','unit','price','quantity','active','kind']);
  });
  if(new Set(items.map(item=>item.product_id)).size!==items.length)badResponse();
  return {items,count:items.length,limit:250,...(change?{action:value.action,product_id:value.product_id,replayed:value.replayed}:{})};
}
// 202610200240: the structure of each product of the document (components per unit and for the item) and its Produção.
function structures(value,route){
  const qty=v=>typeof v==='string'&&/^(0|[1-9][0-9]{0,17})\.[0-9]{6}$/.test(v);
  if(!object(value)||value.kind!==route.kind||value.document_id!==route.id||!Array.isArray(value.items)||value.items.length>250)badResponse();
  const items=value.items.map(item=>{
    if(!only(item,['item_id','position','product_id','production','components'])||!UUID.test(item.item_id||'')||!Number.isInteger(item.position)||item.position<1||item.position>990||!UUID.test(item.product_id||'')
      ||(item.production!==null&&!['own','third_party'].includes(item.production))||!Array.isArray(item.components)||item.components.length>100)badResponse();
    const components=item.components.map(c=>{
      if(!only(c,['product_id','code','description','unit','quantity','total'])||!UUID.test(c.product_id||'')||!nullableText(c.code,100)||typeof c.description!=='string'||!c.description||characters(c.description)>200
        ||!nullableText(c.unit,16)||!qty(c.quantity)||!qty(c.total))badResponse();
      return picked(c,['product_id','code','description','unit','quantity','total']);
    });
    return {item_id:item.item_id,position:item.position,product_id:item.product_id,production:item.production,components};
  });
  if(new Set(items.map(item=>item.item_id)).size!==items.length)badResponse();
  return {kind:route.kind,document_id:route.id,items};
}
// 202610200239: the approval situações of the discount (custom situações of Em digitação, at most five, in order).
function discountApproval(value,operation){
  const save=operation.rpc==='erp_document_discount_approval_save';
  if(!object(value)||value.kind!=='sales_orders'||!Number.isInteger(value.version)||value.version<0||value.version>2147483647||typeof value.can_write!=='boolean'||!Array.isArray(value.situations)||value.situations.length>5
    ||(save&&(typeof value.replayed!=='boolean'||value.version<1)))badResponse();
  const situations=value.situations.map(s=>{
    if(!only(s,['id','name','color','active'])||Object.keys(s).length!==4||!UUID.test(s.id||'')||typeof s.name!=='string'||!s.name.trim()||characters(s.name)>40||typeof s.color!=='string'||!/^#[0-9a-f]{6}$/.test(s.color)||typeof s.active!=='boolean')badResponse();
    return {id:s.id,name:s.name,color:s.color,active:s.active};
  });
  if(new Set(situations.map(s=>s.id)).size!==situations.length||(save&&JSON.stringify(situations.map(s=>s.id))!==JSON.stringify(operation.args.p_situations)))badResponse();
  return {kind:'sales_orders',version:value.version,can_write:value.can_write,situations,...(save?{replayed:value.replayed}:{})};
}
// 202610200239: what the screens enable (Sistema › Usuários › Permissões); absent before 239.
function accessPermissions(value){
  const os=value?.service_orders,so=value?.sales_orders;
  if(!only(value,['service_orders','sales_orders'])||Object.keys(value).length!==2||!only(os,['situations','stock','finance','finance_history','payment_method'])||Object.keys(os).length!==5
    ||Object.values(os).some(flag=>typeof flag!=='boolean')||!only(so,['discount_approver','approval_situations'])||Object.keys(so).length!==2||typeof so.discount_approver!=='boolean'
    ||!Array.isArray(so.approval_situations)||so.approval_situations.length>5||so.approval_situations.some(id=>typeof id!=='string'||!UUID.test(id)))badResponse();
  return {service_orders:{situations:os.situations,stock:os.stock,finance:os.finance,finance_history:os.finance_history,payment_method:os.payment_method},
    sales_orders:{discount_approver:so.discount_approver,approval_situations:[...so.approval_situations]}};
}
function supplierCodes(value,args){
  const wanted=new Set(args.p_product_ids);
  if(!object(value)||value.contact_id!==args.p_contact_id||!Array.isArray(value.items)||value.items.length>wanted.size)badResponse();
  const items=value.items.map(item=>{if(!only(item,['product_id','code'])||!wanted.has(item.product_id)||typeof item.code!=='string'||!item.code.trim()||characters(item.code)>60)badResponse();return {product_id:item.product_id,code:item.code};});
  if(new Set(items.map(item=>item.product_id)).size!==items.length)badResponse();
  return {contact_id:value.contact_id,items};
}
export function documentsResponse(value,route,operation) {
  if(operation.extra){try{return documentExtrasResponse(value,route,operation);}catch(error){if(error instanceof DocumentExtrasError)throw new DocumentsError(error.status,error.code);throw error;}}
  if(!object(value)||value.data_mode!=='erp_native'||value.operational_effects!==false)badResponse();
  const base={data_mode:'erp_native',operational_effects:false};
  if(route.action==='report'){try{return documentReportResponse(value,route,operation);}catch(error){if(error instanceof DocumentReportError)throw new DocumentsError(error.status,error.code);throw error;}}
  if(operation.type==='list_view'){
    const allowed=LIST_VIEW_COLUMNS[route.kind],array=value=>Array.isArray(value)&&value.every(item=>typeof item==='string');
    if(value.kind!==route.kind||typeof value.custom_view!=='boolean'||!array(value.columns)||value.columns.some(column=>!allowed.includes(column))||new Set(value.columns).size!==value.columns.length
      ||!array(value.default_statuses)||value.default_statuses.some(status=>!situationKey(route.kind,status))||typeof value.statuses_saved!=='boolean'
      ||JSON.stringify(value.available_columns)!==JSON.stringify(allowed)||value.column_limit!==8||!Number.isInteger(value.version)||value.version<0
      ||(value.replayed!==undefined&&typeof value.replayed!=='boolean'))badResponse();
    return {...base,...(value.replayed===undefined?{}:{replayed:value.replayed}),kind:route.kind,custom_view:value.custom_view,columns:[...value.columns],default_statuses:[...value.default_statuses],statuses_saved:value.statuses_saved,
      available_columns:[...allowed],column_limit:8,version:value.version};
  }
  if(operation.type==='occurrences'){
    const d=value.document;
    if(value.kind!==route.kind||!object(d)||d.id!==route.id||d.kind!==route.kind||typeof d.number!=='string'||!/^[1-9][0-9]{0,9}$/.test(d.number)||!Object.hasOwn(STATES[route.kind],d.status)
      ||!Number.isInteger(d.version)||d.version<1||!Array.isArray(value.items)||value.items.length>500||typeof value.has_more!=='boolean'||typeof value.can_write!=='boolean')badResponse();
    const items=value.items.map(item=>occurrence(item,route.kind,route.id));
    if(new Set(items.map(item=>item.id)).size!==items.length||items.some((item,index)=>index>0&&item.sequence>=items[index-1].sequence))badResponse();
    // 202610200163: current situação and Preferências "Permite a edição da data e hora das ocorrências" (absent before 163).
    if(value.date_editable!==undefined&&typeof value.date_editable!=='boolean')badResponse();
    return {...base,kind:route.kind,document:{...picked(d,['id','kind','number','status','version']),...(Object.hasOwn(d,'situation')?{situation:shape(()=>situationValue(d.situation,route.kind,d.status))}:{})},
      items,has_more:value.has_more,can_write:value.can_write,...(value.date_editable!==undefined?{date_editable:value.date_editable}:{})};
  }
  if(operation.type==='occurrence'){
    if(value.kind!==route.kind||typeof value.replayed!=='boolean')badResponse();
    const doc=document(value.document,route.kind);if(doc.id!==route.id)badResponse();
    // 202610200196: the change of situação of the occurrence may post contas automatically (pedidos de venda).
    const auto=value.auto_finance!==undefined?(route.kind!=='sales_orders'?badResponse():{auto_finance:autoFinance(value.auto_finance)}):{};
    return {...base,replayed:value.replayed,kind:route.kind,document:doc,occurrence:occurrence(value.occurrence,route.kind,route.id),...auto};
  }
  if(operation.type==='next_number'){
    const number=v=>v===null||documentNumber(v),setting=operation.rpc==='erp_document_numbering_set';
    if(value.kind!==route.kind||value.reserved!==false||!number(value.next_number)||(value.minimum_next_number!==undefined&&!number(value.minimum_next_number))
      ||(value.replayed!==undefined&&typeof value.replayed!=='boolean')||(setting&&(typeof value.replayed!=='boolean'||value.minimum_next_number===undefined||value.next_number===null)))badResponse();
    // A database before 129 sends no minimum; the screen then keeps "Próximo número" read-only.
    return {...base,kind:route.kind,next_number:value.next_number,reserved:false,...(value.minimum_next_number!==undefined?{minimum_next_number:value.minimum_next_number}:{}),...(setting?{replayed:value.replayed}:{})};
  }
  if(operation.type==='situations')return {...base,...shape(()=>situationsPage(value,route.kind))};
  if(operation.type==='categories')return {...base,...categoriesPage(value,route.kind)};
  if(operation.type==='payment_options')return {...base,...paymentOptions(value,route.kind)};
  if(operation.type==='sales_bag')return {...base,...salesBag(value,operation)};
  if(operation.type==='signature'){
    const text=(v,max)=>v===null||(typeof v==='string'&&v.trim()!==''&&characters(v)<=max);
    if(!text(value.greeting,200)||!text(value.department,100)||!Number.isInteger(value.version)||value.version<0||value.version>2147483647||(value.name!==null&&!text(value.name,200))
      ||(operation.rpc==='erp_document_signature_save'&&(typeof value.replayed!=='boolean'||value.version<1)))badResponse();
    return {...base,greeting:value.greeting,department:value.department,version:value.version,name:value.name,...(operation.rpc==='erp_document_signature_save'?{replayed:value.replayed}:{})};
  }
  if(operation.type==='print_header'){
    let content;try{content=normalizeRichText(value.content);}catch{return badResponse();}
    const saving=operation.rpc==='erp_document_print_header_save';
    if(value.kind!==route.kind||!Number.isInteger(value.version)||value.version<0||value.version>2147483647||typeof value.can_manage!=='boolean'
      ||(value.updated_at!==null&&(typeof value.updated_at!=='string'||value.updated_at.length>100||!Number.isFinite(Date.parse(value.updated_at))))||(value.version===0)!==(value.updated_at===null)
      ||(saving&&(typeof value.replayed!=='boolean'||value.version<1)))badResponse();
    return {...base,kind:route.kind,content,version:value.version,updated_at:value.updated_at,can_manage:value.can_manage,...(saving?{replayed:value.replayed}:{})};
  }
  if(operation.type==='supplier_codes')return {...base,...supplierCodes(value,operation.args)};
  if(operation.type==='discount_approval')return {...base,...discountApproval(value,operation)};
  if(operation.type==='structures')return {...base,...structures(value,route)};
  if(operation.type==='from_proposal'){
    const source=value.source;
    if(value.kind!==route.kind||value.persisted!==false||!object(source)||source.id!==route.proposal||source.kind!=='sales_proposals'||!documentNumber(source.number)
      ||!Number.isInteger(source.version)||source.version<1||source.version>2147483647||!object(value.data))badResponse();
    const data=picked(value.data,INPUT_FIELDS);
    if(!Array.isArray(value.data.items)||!Array.isArray(value.data.installments??[]))badResponse();
    data.items=value.data.items.map(item=>object(item)?picked(item,ITEM_FIELDS):null);data.installments=(value.data.installments??[]).map(row=>object(row)?picked(row,INSTALLMENT_FIELDS):null);
    let normalized;try{normalized=normalizeDocument(route.kind,data);}catch{return badResponse();}
    const contact=value.contact,listName=value.price_list_name;
    if(normalized.items.some(item=>item.id!==null)||normalized.template||!only(contact,['id','name'])||contact.id!==normalized.contact_id||typeof contact.name!=='string'||!contact.name||characters(contact.name)>200
      ||(listName!==null&&(normalized.price_list_id===undefined||normalized.price_list_id===null||typeof listName!=='string'||!listName||characters(listName)>120)))badResponse();
    return {...base,kind:route.kind,source:{id:source.id,kind:'sales_proposals',number:source.number,version:source.version},data,contact:{id:contact.id,name:contact.name},price_list_name:listName,persisted:false};
  }
  if(operation.type==='history')return {...base,...historyPage(value,route.kind,operation.args)};
  if(operation.type==='export')return {...base,...exportPage(value,route.kind,operation.args)};
  if(operation.type==='xml_import')return {...base,...shape(()=>xmlImportResult(value,route.kind,operation.draft))};
  if(operation.type==='pendencies'){
    const d=value.document;
    if(value.kind!=='sales_orders'||!object(d)||d.id!==route.id||d.kind!=='sales_orders'||!documentNumber(d.number)||!Object.hasOwn(STATES.sales_orders,d.status)||!Number.isInteger(d.version)||d.version<1
      ||!Array.isArray(value.pendencies)||value.pendencies.length>300||value.pendencies.some(p=>!only(p,['section','message'])||typeof p.section!=='string'||characters(p.section)>260||typeof p.message!=='string'||characters(p.message)>200))badResponse();
    return {...base,kind:'sales_orders',document:picked(d,['id','kind','number','status','version']),pendencies:value.pendencies.map(p=>({section:p.section,message:p.message}))};
  }
  if(operation.type==='sales_to_service'){
    if(value.replayed!==undefined&&typeof value.replayed!=='boolean')badResponse();
    const sale=document(value.sale,'sales_orders'),service=document(value.service_order,'service_orders');
    if(sale.id!==route.id||service.id===sale.id||(value.replayed!==true&&(service.version!==1||service.status!=='open')))badResponse();
    return {...base,replayed:value.replayed===true,sale,service_order:service};
  }
  if(operation.type==='occurrence_remove'){
    const d=value.document;
    if(value.kind!==route.kind||typeof value.replayed!=='boolean'||value.removed_id!==route.occurrence||!object(d)||d.id!==route.id||d.kind!==route.kind||!documentNumber(d.number)
      ||!Object.hasOwn(STATES[route.kind],d.status)||!Number.isInteger(d.version)||d.version<1)badResponse();
    return {...base,replayed:value.replayed,kind:route.kind,document:picked(d,['id','kind','number','status','version']),removed_id:value.removed_id};
  }
  if(operation.type==='access'){
    if(value.mirror_available!==undefined&&typeof value.mirror_available!=='boolean')badResponse();
    for(const key of ['read','write'])if(!Array.isArray(value[key])||value[key].some(kind=>!KINDS.includes(kind)))badResponse();
    // 202610200164: settings applied by the document screens and the vendedor linked to the user (absent before 164).
    return {...base,read:[...new Set(value.read)],write:[...new Set(value.write)],...(value.mirror_available===undefined?{}:{mirror_available:value.mirror_available}),...(Object.hasOwn(value,'settings')?{settings:accessSettings(value.settings),seller:accessSeller(value.seller)}:{}),
      ...(Object.hasOwn(value,'permissions')?{permissions:accessPermissions(value.permissions)}:{})};
  }
  if(value.replayed!==undefined&&typeof value.replayed!=='boolean')badResponse();
  const replay=value.replayed===undefined?{}:{replayed:value.replayed};
  if(operation.type==='conversion'){
    const proposal=document(value.proposal,'sales_proposals'),sale=document(value.sale,'sales_orders');
    if(proposal.status!=='completed'||sale.source_proposal_id!==proposal.id||sale.id===proposal.id||proposal.id!==route.id)badResponse();
    return {...base,...replay,proposal,sale};
  }
  if(value.kind!==route.kind)badResponse();
  if(operation.type==='list'){
    const args=operation.args;
    if(!Array.isArray(value.items)||value.items.length>args.p_limit||value.limit!==args.p_limit||typeof value.has_more!=='boolean'
      ||(value.has_more?!UUID.test(value.next_cursor||''):value.next_cursor!==null)||value.page!==args.p_page||value.order!==args.p_order
      ||!Number.isSafeInteger(value.total_count)||value.total_count<0
      // 202610200129: null when Preferências "Exibir totais em listas" leaves this user without the sum of the list.
      ||(value.total_amount!==null&&(typeof value.total_amount!=='string'||!/^(0|[1-9][0-9]{0,17})\.[0-9]{2}$/.test(value.total_amount))))badResponse();
    // Page mode: the page, its size and has_more must agree with the filtered total from the same predicate.
    // A page past the end (the set shrank after a change) is empty with has_more=false; the UI then moves to the last page.
    if(args.p_page!==null){const before=(args.p_page-1)*args.p_limit,expected=Math.max(0,Math.min(args.p_limit,value.total_count-before));if(value.items.length!==expected||value.has_more!==(before+expected<value.total_count))badResponse();}
    else if(value.items.length>value.total_count)badResponse();
    const items=value.items.map(item=>summary(item,route.kind));
    if(new Set(items.map(item=>item.id)).size!==items.length)badResponse();
    const origins=Object.hasOwn(value,'origin_totals')&&value.origin_totals!==null?shape(()=>documentOriginTotals(value.origin_totals)):null;
    if(origins&&(origins.brufap.count+origins.origin.count!==value.total_count||origins.brufap.count>0&&origins.origin.count>0&&value.total_amount!==null))badResponse();
    if(operation.args.p_origin&&operation.args.p_origin!=='all'&&items.some(item=>(item.origin??'brufap')!==operation.args.p_origin))badResponse();
    return {...base,kind:route.kind,items,limit:value.limit,page:value.page,order:value.order,has_more:value.has_more,next_cursor:value.next_cursor,total_count:value.total_count,total_amount:value.total_amount,...(origins?{origin_totals:origins}:{})};
  }
  // 202610200269: Salvar nova versão answers the new proposta (checked against the version below).
  const doc=document(value.document,route.kind);if(route.id&&doc.id!==route.id&&operation.rpc!=='erp_document_proposal_version')badResponse();
  // 202610200163: the transition reports the actions it ran (Estornar/Lançar estoque e contas).
  const effects=operation.rpc==='erp_document_transition'&&value.effects!==undefined?{effects:shape(()=>transitionEffects(value.effects))}:{};
  // 202610200196: automatic lançamento de contas (pedidos de venda) and the proposta concluded by the save of the new document.
  // 202610200267: also the contas a pagar of the pedido de compra, only in the save that creates it.
  const autoAllowed=route.kind==='sales_orders'||(route.kind==='purchase_orders'&&operation.rpc==='erp_document_save');
  const auto=value.auto_finance!==undefined?(!autoAllowed?badResponse():{auto_finance:autoFinance(value.auto_finance)}):{};
  // 202610200239: the pedido above the discount limit went to the approval situação (Em digitação).
  let approval={};
  if(value.discount_approval!==undefined){
    const a=value.discount_approval;
    if(route.kind!=='sales_orders'||operation.rpc!=='erp_document_save'||!only(a,['situation'])||doc.status!=='draft')badResponse();
    const situation=shape(()=>situationValue(a.situation,'sales_orders','draft'));if(situation.default)badResponse();
    approval={discount_approval:{situation}};
  }
  let source={};
  if(value.source_proposal!==undefined||operation.source_proposal){
    const s=value.source_proposal;
    if(!object(s)||s.id!==operation.source_proposal||s.status!=='completed'||!documentNumber(s.number)||!Number.isInteger(s.version)||s.version<2||doc.source_proposal_id!==s.id)badResponse();
    source={source_proposal:{id:s.id,number:s.number,version:s.version,status:'completed'}};
  }
  // 202610200269 Salvar nova versão: the version made and the proposta it came from.
  let version={};
  if(operation.rpc==='erp_document_proposal_version'){
    const v=proposalVersion(value.proposal_version),s=value.source;
    if(!v||v.seq<2||v.superseded||doc.id!==v.latest.id||!object(s)||s.id!==route.id||!documentNumber(s.number)||!Number.isInteger(s.version)||s.version<1)badResponse();
    version={proposal_version:v,source:{id:s.id,number:s.number,version:s.version}};
  }
  return {...base,...replay,kind:route.kind,document:doc,...effects,...auto,...approval,...source,...version};
}
