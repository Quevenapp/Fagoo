import { EXTENSION_FIELDS, normalizeDocument, STATES, type DocumentInput, type DocumentKind, type NormalizedDocument, type NormalizedItem } from '../../../../packages/erp-domain/src/index.mjs';
import { normalizeUnitPrice } from '../../../../packages/erp-domain/src/unit-price.mjs';
import { groupedItems, itemGroup } from './service-order-items.ts';
import type { DocumentOrigin } from './document-mirror-model.ts';
export { KINDS, STATES, TRANSITIONS, canEdit, checkTransition, calculateDocument } from '../../../../packages/erp-domain/src/index.mjs';
export type { DocumentKind, DocumentInput, DocumentItemInput, InstallmentInput, InstallmentDetails, DocumentTotals, CommercialData, CommercialTransport, CommercialReference, DeliveryAddress } from '../../../../packages/erp-domain/src/index.mjs';
export { EXTENSION_FIELDS, DELIVERY_ADDRESS_FIELDS } from '../../../../packages/erp-domain/src/index.mjs';
export const DOCUMENT_LABELS: Record<DocumentKind,string> = { sales_proposals:'Propostas comerciais',sales_orders:'Pedidos de venda',purchase_orders:'Pedidos de compra',service_orders:'Ordens de serviço' };
export interface DocumentAccess { read:DocumentKind[];write:DocumentKind[];data_mode:'erp_native';operational_effects:false;
  mirror_available?:boolean;
  /** 202610200164 (absent before it): company settings applied by the document screens and the vendedor linked to the user. */
  settings?:DocumentSettings;seller?:DocumentSeller|null;
  /** 202610200239 (absent before it): what Sistema › Usuários › Permissões leaves the user do (the server checks each action again). */
  permissions?:DocumentPermissions; }
export interface DocumentPermissions {
  service_orders:{situations:boolean;stock:boolean;finance:boolean;finance_history:boolean;payment_method:boolean};
  /** Preferências › Vendas "Situação para aprovação de descontos": the approval situações and whether the user approves. */
  sales_orders:{discount_approver:boolean;approval_situations:string[]};
}
export interface DocumentSettings { price_decimals_out:number;price_decimals_in:number;
  /** 202610200199 Preferências › Empresa "Número de casas decimais no peso do produto" (absent before 199). */
  weight_decimals?:number;
  /** 202610200287 Preferências › Empresa "Número de casas decimais na quantidade" (0 to 6; absent before 287 = 6). */
  quantity_decimals?:number;cross_docking_days:number;occurrence_date_editable:boolean;stock_launch_date:'data_atual'|'data_documento';
  auto_products:{sales:boolean;purchases:boolean;services:boolean};default_warehouse:{id:string;name:string}|null; }
export interface DocumentSeller { id:string;name:string;allow_unregistered_products:boolean;view_stock:boolean;discount_limit:string; }
export interface DocumentSummary extends DocumentOrigin { id:string;kind:DocumentKind;number:string|null;version:number;status:string;date:string|null;total:string|null;contact_id:string|null;contact_name:string|null;created_at:string;updated_at:string; }
export interface DocumentRecord extends Omit<NormalizedDocument,'items'>, DocumentOrigin {
  id:string;kind:DocumentKind;number:string;version:number;status:string;created_at:string;updated_at:string;source_proposal_id:string|null;
  effect_flags:{finance_active:boolean;stock_active:boolean;origin_finance?:boolean;origin_invoice?:boolean};
  contact_snapshot:{id:string;name:string;[key:string]:unknown};items:(NormalizedItem&{product_snapshot:Record<string,unknown>|null})[];
  /** 202610200163/168 reads: names of the vendedor, of the categoria and of the transportador of the cadastro. */
  seller_name?:string|null;category_name?:string|null;carrier_name?:string|null;
  /** 202610200196 reads: names of the Lista de preço, of the Destino and of the Formas / contas of the parcelas. */
  price_list_name?:string|null;payment_account_name?:string|null;payment_method_names?:Record<string,string>;payment_account_names?:Record<string,string>;
  /** 202610200269 reads of a proposta: its versions (Origin "Salvar nova versão"; null without other versions). */
  proposal_version?:ProposalVersion|null;
}
export interface ProposalVersion { base_id:string;base_number:string;seq:number;label:string;versions:number;superseded:boolean;latest:{id:string;label:string} }
/** Número shown for a document: the version label of a proposta ("123-2"), else its number. */
export const documentLabel=(record:{number:string;proposal_version?:ProposalVersion|null}):string=>record.proposal_version?.label??record.number;
export interface DocumentPage { kind:DocumentKind;items:DocumentSummary[];limit:number;has_more:boolean;next_cursor:string|null;data_mode:'erp_native';operational_effects:false; }
export interface DocumentEnvelope { kind:DocumentKind;document:DocumentRecord;replayed?:boolean;data_mode:'erp_native';operational_effects:false; }
interface ConversionBase { proposal:DocumentRecord;replayed:boolean;data_mode:'erp_native';operational_effects:false; }
export interface SaleConversionEnvelope extends ConversionBase { sale:DocumentRecord;service_order?:never; }
export interface ServiceConversionEnvelope extends ConversionBase { service_order:DocumentRecord;sale?:never; }
export type ConversionEnvelope=SaleConversionEnvelope|ServiceConversionEnvelope;
export type ConversionKind='sales_orders'|'service_orders';
export function conversionDocument(value:ConversionEnvelope):DocumentRecord {
 const uuid=(id:unknown)=>typeof id==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);
 if(!value||typeof value!=='object'||value.data_mode!=='erp_native'||value.operational_effects!==false||typeof value.replayed!=='boolean'
  ||!value.proposal||!uuid(value.proposal.id)||value.proposal.kind!=='sales_proposals'||value.proposal.status!=='completed')throw new Error('Conversão inválida.');
 const service=Boolean(value.service_order),sale=Boolean(value.sale),target=service?value.service_order:value.sale;
 if(service===sale||!target||!uuid(target.id)||target.id===value.proposal.id||target.kind!==(service?'service_orders':'sales_orders')
  ||target.source_proposal_id!==value.proposal.id||!Number.isInteger(target.version)||target.version<1)throw new Error('Conversão inválida.');
 return target;
}
export interface DocumentFilters {query:string;status:string;from:string;to:string;}
export const EMPTY_DOCUMENT_FILTERS:DocumentFilters={query:'',status:'',from:'',to:''};
export function documentListParams(kind:DocumentKind,filters:DocumentFilters,after:string|null=null):URLSearchParams {
 const {query,status,from,to}=filters;
 if(query.length>120||/[\x00-\x1f\x7f]/.test(query))throw new Error('A pesquisa deve ter até 120 caracteres, sem quebras de linha.');
 for(const value of [from,to])if(value){
  const date=new Date(`${value}T00:00:00.000Z`);
  if(!/^(19|20)\d{2}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value)throw new Error('Informe datas válidas entre 1900 e 2099.');
 }
 if(from&&to&&from>to)throw new Error('A data inicial deve ser anterior ou igual à data final.');
 if(status&&!Object.hasOwn(STATES[kind],status))throw new Error('Escolha uma situação válida para este documento.');
 if(after&&!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(after))throw new Error('Atualize a listagem para reiniciar a paginação.');
 const params=new URLSearchParams({limit:'25'});
 if(after)params.set('after',after);if(status)params.set('status',status);if(query.trim())params.set('q',query.trim());if(from)params.set('date_from',from);if(to)params.set('date_to',to);
 return params;
}
const OPTIONAL_TEXT=['notes','internal_notes','payment_terms','delivery_terms','equipment','serial_number','technician','defect','solution'] as const;
/** `notes`: Origin "Observação padrão" of the kind's Preferências page (empty keeps the field empty). */
export function freshDocument(kind:DocumentKind,today:string,notes=''):DocumentInput {
  // Origin: a new pedido starts with "0 - Contratação do Frete por conta do Remetente (CIF)".
  const commercial=kind==='sales_orders'?{introduction:null,attention_to:null,seller_reference:null,store_reference:null,business_unit_reference:null,transport:{freight_mode:'0' as const,volume_count:null,gross_weight:null,delivery_days:null,carrier_reference:null,service_reference:null,tracking_code:null}}:null;
  // Origin: Data saída starts on the day of the sale (pedido); the OS keeps it empty until the part is collected.
  const extension:Partial<DocumentInput>=kind==='sales_orders'?{ship_date:today}:{};
  if(notes)extension.notes=notes;
  return {...extension,date:today,contact_id:'',warehouse_id:null,items:kind==='service_orders'?[]:[{id:crypto.randomUUID(),product_id:null,description:'',code:null,unit:'UN',quantity:'1',unit_price:'0',discount_percent:'0',detailed_description:null}],discount_mode:'amount',discount_value:'0',freight:'0',other_expenses:'0',installments:[],commercial};
}
// Every 202610200102 field is sent (null when not used), so the server guard never sees a field silently dropped; from 202610200196
// also the Preço lista and Código no fornecedor of the items and the Forma and details of the parcelas; from 202610200268 the group,
// Orçar and OK of every item of the OS.
export function explicitDocumentInput(input:DocumentInput,kind?:DocumentKind):DocumentInput {
 const extension=Object.fromEntries(EXTENSION_FIELDS.map(key=>[key,Object.hasOwn(input,key)&&input[key]!==undefined?structuredClone(input[key]):null]));
 return {...extension,...structuredClone(input),commercial:input.commercial?structuredClone(input.commercial):null,items:groupedItems(kind??'sales_orders',input.items).map(item=>({...item,detailed_description:item.detailed_description??null,list_price:item.list_price??null,supplier_code:item.supplier_code??null})),
  installments:(input.installments??[]).map(row=>({...row,note:row.note??null,payment_reference:row.payment_reference?structuredClone(row.payment_reference):null,payment_method_id:row.payment_method_id??null,
   ...(kind==='sales_proposals'?{}:{details:row.details?structuredClone(row.details):null})}))};
}
export function documentInput(record:DocumentRecord):DocumentInput {
  const input:DocumentInput={date:record.date,contact_id:record.contact_id,warehouse_id:record.warehouse_id,expected_date:record.expected_date,valid_until:record.valid_until,next_contact:record.next_contact,template:record.template,
    items:record.items.map(item=>({id:item.id,product_id:item.product_id,description:item.description,code:item.code,unit:item.unit,quantity:item.quantity,unit_price:item.unit_price,discount_percent:item.discount_percent,detailed_description:item.detailed_description??null,
      ...(item.list_price!==undefined?{list_price:item.list_price}:{}),...(item.supplier_code!==undefined?{supplier_code:item.supplier_code}:{}),
      // 202610200287: Informar lotes, Garantia of the item of the OS and IPI % of the pedido de compra (kept as saved: an identical rewrite).
      ...(item.lots!==undefined?{lots:structuredClone(item.lots)}:{}),...(item.warranty_days!==undefined?{warranty_days:item.warranty_days}:{}),...(item.ipi_rate!==undefined?{ipi_rate:item.ipi_rate}:{}),
      // 202610200268: the group of an OS item saved before it comes from the type of its product (Serviço = S).
      ...(record.kind==='service_orders'?(group=>({group,quote:group==='service'&&item.quote===true,done:group==='service'&&item.done===true}))(itemGroup(item,item.product_snapshot?.kind)):{})})),
    discount_mode:record.discount_mode,discount_value:record.discount_value,freight:record.freight,other_expenses:record.other_expenses,
    installments:record.installments.map(row=>({due_date:row.due_date,amount:row.amount,method:row.method,note:row.note??null,payment_reference:row.payment_reference?structuredClone(row.payment_reference):null,
      ...(row.payment_method_id!==undefined?{payment_method_id:row.payment_method_id}:{}),...(row.details!==undefined?{details:structuredClone(row.details)}:{})})),commercial:record.commercial?structuredClone(record.commercial):null};
  // 202610200196: Total do IPI / ICMS ST of the document (kept while the record carries them).
  for(const field of ['tax_ipi','tax_icms_st'] as const)if(record[field]!==undefined)input[field]=record[field];
  for(const field of OPTIONAL_TEXT)input[field]=record[field];
  // 202610200287: Campos customizados of the OS.
  if(record.custom_fields!==undefined)input.custom_fields=structuredClone(record.custom_fields);
  for(const field of EXTENSION_FIELDS)if(Object.hasOwn(record,field))(input as unknown as Record<string,unknown>)[field]=structuredClone(record[field]);
  return input;
}
export function documentValidation(kind:DocumentKind,input:DocumentInput):string|null {
  if(!input.contact_id)return 'Selecione o cliente ou fornecedor.';
  try{
    for (const item of input.items) {
      try { normalizeUnitPrice(item.unit_price, 10); }
      catch { return 'Confira o preço unitário: até dez dígitos inteiros e dez casas decimais, sem separador de milhar ou arredondamento.'; }
    }
    normalizeDocument(kind,input);return null;
  }catch(error){
    const code=error instanceof Error?error.message:'';
    if(code.includes('INSTALLMENT_TOTAL'))return 'A soma das parcelas precisa ser igual ao total do documento.';
    if(code.includes('DATE'))return 'Confira as datas informadas.';
    if(code.includes('DISCOUNT_EXCEEDS'))return 'O desconto não pode ultrapassar o subtotal dos itens.';
    // 202610200287: before the generic QUANTITY message (DOCUMENT_ITEM_LOTS_QUANTITY also contains QUANTITY).
    if(code.includes('LOTS_QUANTITY'))return 'A soma das quantidades dos lotes precisa ser igual à quantidade do item (Informar lotes).';
    if(code.includes('DECIMAL')||code.includes('PERCENT')||code.includes('QUANTITY'))return 'Confira quantidades, preços e descontos. Use vírgula ou ponto decimal, sem separador de milhar, e valores não negativos.';
    if(code.includes('COMMERCIAL')||code.includes('REFERENCE'))return 'Confira as informações comerciais, os IDs Origin e a precisão dos dados de transporte.';
    if(code.includes('DELIVERY_ADDRESS'))return 'Confira o endereço de entrega: informe endereço e cidade, CEP com oito dígitos e uma UF válida.';
    if(code.includes('TIME'))return 'Confira as horas de início e término (hh:mm).';
    if(code.includes('WARRANTY'))return 'Confira a garantia: informe um número inteiro.';
    if(code.includes('LOTS'))return 'Confira os lotes informados: lotes do próprio produto, sem repetir, com quantidade maior que zero.';
    if(code.includes('CUSTOM_FIELDS'))return 'Confira os campos customizados da ordem de serviço.';
    if(code.includes('TAX'))return kind==='purchase_orders'?'Confira o IPI % dos itens: até 100%, com até quatro casas decimais.':'Confira o Total do IPI e o Total do ICMS ST.';
    if(code.includes('ITEM'))return 'Confira os itens: descrição, unidade e quantidade são obrigatórias.';
    if(code.includes('NUMBER'))return 'Informe um número de 1 a 9999999999, sem zeros à esquerda.';
    return 'Confira os campos e limites antes de salvar.';
  }
}
