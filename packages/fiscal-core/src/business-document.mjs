/** Initial, explicit business profile. Pure data/decimal checks; never fiscal authorization. */
import { normalizeDocument, STATES } from '../../erp-domain/src/index.mjs';
import { buildAccessKey, isValidCnpj, validFiscalTimestamp } from './identity.mjs';
import { fiscalExactDecimal } from './review.mjs';
import { gtinCheckDigitMatches } from './item-preparation.mjs';
import { resolveTaxItems } from './tax-preparation.mjs';
import { COMPLETION_FLAGS, resolveBusinessCompletion } from './business-completion.mjs';

export const BUSINESS_PROFILE = 'sn-sp-internal-business-v1';
export const BUSINESS_SCHEMA = 'pl010f-v1.04';
export const BUSINESS_BUILDER = 'fagoo-business-builder-v1';
export const BUSINESS_CONTENT_FINGERPRINT_PROFILE = 'fagoo-business-content-basis-v1';
export const HOMOLOGATION_RECIPIENT = 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';
export const HOMOLOGATION_PRODUCT = 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';
export const BUSINESS_FLAGS = Object.freeze({ operational_effects:false, numbering_reserved:false, tax_rules_validated:false,
  xsd_validated:false, signature_verified:false, authorized:false, can_emit:false, can_transmit:false });
export const TOTAL_FIELDS = Object.freeze(['vBC','vICMS','vICMSDeson','vFCP','vBCST','vST','vFCPST','vFCPSTRet',
  'vProd','vFrete','vSeg','vDesc','vII','vIPI','vIPIDevol','vPIS','vCOFINS','vOutro','vNF']);
const ZERO_FIELDS = ['vBC','vICMS','vICMSDeson','vFCP','vBCST','vST','vFCPST','vSeg','vII','vIPI','vIPIDevol'];
const EXCLUDED = ['ipi','ii','issqn','ibs_cbs','is','monophase','destination_icms'];
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_CENTS = 999999999999999n;
const resolvedContents = new WeakSet();
const freezeTree = value => { if(value!==null&&typeof value==='object'){for(const child of Object.values(value))freezeTree(child);Object.freeze(value);}return value; };
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact = (v, keys) => plain(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k));
const id = v => typeof v === 'string' && UUID.test(v);
const version = v => Number.isInteger(v) && v >= 1 && v <= 2147483647;
const pick = (v, keys) => Object.fromEntries(keys.map(k => [k,v[k]]));
// JSON objects are unordered, including JSONB responses. Only array order is significant.
function canonical(value,depth=0) {
  need(depth<=12,'BUSINESS_INPUT_INVALID');
  if(Array.isArray(value)){need(value.length<=500);return value.map(v=>canonical(v,depth+1));}
  if(plain(value)){const keys=Object.keys(value).sort();need(keys.length<=64);return Object.fromEntries(keys.map(k=>[k,canonical(value[k],depth+1)]));}
  return value;
}
const equal = (a,b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export const BUSINESS_ERRORS = Object.freeze({
  BUSINESS_INPUT_INVALID:'O documento ou complemento não segue o contrato do gerador.',
  BUSINESS_CONTENT_UNATTESTED:'O conteúdo deve ser conferido novamente neste processo antes de vincular a identidade.',
  BUSINESS_BASIS_CONFLICT:'As versões do rascunho, itens, tributos ou empresa não correspondem.',
  BUSINESS_SOURCE_CHANGED:'A origem foi alterada, cancelada ou arquivada; atualize a preparação.',
  BUSINESS_PROFILE_UNSUPPORTED:'A operação está fora do perfil interno inicial.',
  BUSINESS_TEXT_INVALID:'Um texto excede o limite ou contém caracteres incompatíveis com o XML.',
  BUSINESS_ADDRESS_INVALID:'O endereço completo e o município devem ser conferidos explicitamente.',
  BUSINESS_RECIPIENT_INVALID:'Documento ou indicador fiscal do destinatário exige conferência.',
  BUSINESS_ITEM_UNPREPARED:'Há identificação de item ausente ou uma decisão não conferida.',
  BUSINESS_QUANTITY_PRECISION:'A quantidade não cabe em quatro casas sem perda; não foi arredondada.',
  BUSINESS_DECIMAL_INVALID:'O valor decimal está ausente, inválido ou fora do limite.',
  BUSINESS_ARITHMETIC_MISMATCH:'Valores, rateios, totais ou pagamentos não conferem exatamente.',
  BUSINESS_TAX_UNPREPARED:'O grupo tributário selecionado está incompleto.',
  BUSINESS_GROUP_DECISION_REQUIRED:'A inclusão ou omissão do grupo deve ser explicitamente conferida.',
  BUSINESS_PAYMENT_UNSUPPORTED:'O pagamento está fora do recorte inicial ou não confere com o total.',
});
export class BusinessDocumentError extends Error {
  constructor(code, itemId=null) { super(code); this.name='BusinessDocumentError'; this.code=code; this.item_id=id(itemId)?itemId:null; this.pending=BUSINESS_ERRORS[code]??BUSINESS_ERRORS.BUSINESS_INPUT_INVALID; }
}
const need = (test,code='BUSINESS_INPUT_INVALID',itemId=null) => { if(!test)throw new BusinessDocumentError(code,itemId); };
const text = (v,max,min=1) => { need(typeof v==='string' && v.length>=min && v.length<=max && /^(?:[!-ÿ]|[!-ÿ][ -ÿ]*[!-ÿ])$/.test(v),'BUSINESS_TEXT_INVALID'); return v; };
const money = v => { need(typeof v==='string' && /^(?:0|[1-9][0-9]{0,12})\.[0-9]{2}$/.test(v),'BUSINESS_DECIMAL_INVALID'); return BigInt(v.replace('.','')); };
const format = n => { need(n>=0n&&n<=MAX_CENTS,'BUSINESS_DECIMAL_INVALID'); return `${n/100n}.${String(n%100n).padStart(2,'0')}`; };
const rate = v => { need(typeof v==='string' && /^(?:0|[1-9][0-9]{0,2})\.[0-9]{2,4}$/.test(v),'BUSINESS_DECIMAL_INVALID'); const [w,f]=v.split('.'); const n=BigInt(w)*10000n+BigInt(f.padEnd(4,'0')); need(n<=1000000n,'BUSINESS_PROFILE_UNSUPPORTED'); return n; };
const rounded = (n,d) => (n+d/2n)/d;
const units = (v,scale,integers,code='BUSINESS_DECIMAL_INVALID') => {
  const value=fiscalExactDecimal(v,scale,integers); need(value!==null,code);
  const [w,f='']=value.split('.'); return {lexical:value,value:BigInt(w)*10n**BigInt(scale)+BigInt(f.padEnd(scale,'0'))};
};
function taxAmount(base,percentage,amount) {
  need(rounded(money(base)*rate(percentage),1000000n)===money(amount),'BUSINESS_ARITHMETIC_MISMATCH');
}
function cpf(v) {
  if(typeof v!=='string'||!/^\d{11}$/.test(v)||/^(\d)\1{10}$/.test(v))return false;
  for(let n=9;n<11;n++){let s=0;for(let p=0;p<n;p++)s+=Number(v[p])*(n+1-p);const d=(s*10)%11;if(Number(v[n])!==(d===10?0:d))return false;}return true;
}
function address(v,municipality) {
  need(plain(v)&&v.state==='SP'&&typeof municipality==='string'&&/^35[0-9]{5}$/.test(municipality)
    &&typeof v.postal_code==='string'&&/^[0-9]{8}$/.test(v.postal_code),'BUSINESS_ADDRESS_INVALID');
  return {street:text(v.street,60,2),number:text(v.number,60),complement:v.complement===null?null:text(v.complement,60),
    district:text(v.district,60,2),city:text(v.city,60,2),municipality_code:municipality,state:'SP',postal_code:v.postal_code};
}
function checkBasis(draft,itemEnvelope,taxEnvelope) {
  need(plain(draft)&&draft.data_mode==='fiscal_draft'&&draft.emission_enabled===false&&draft.operational_effects===false);
  const d=draft.record,s=d?.snapshot,c=draft.current,i=itemEnvelope?.record,t=taxEnvelope?.record;
  need(plain(d)&&plain(s)&&plain(c)&&id(d.id)&&version(d.version)&&typeof d.snapshot_hash==='string'&&HASH.test(d.snapshot_hash)
    &&['55','65'].includes(d.model)&&d.environment==='2'&&id(d.source_document_id)&&version(d.source_document_version));
  need(d.status==='draft'&&c.status==='draft'&&c.version===d.version&&c.source_document_version===d.source_document_version
    &&c.source_changed===false&&c.company_changed===false&&Object.hasOwn(STATES.sales_orders,c.source_status)&&c.source_status===s.status&&c.source_status!=='cancelled','BUSINESS_SOURCE_CHANGED');
  need(s.kind==='sales_orders'&&s.catalog_basis==='document_snapshot'&&s.document_id===d.source_document_id&&s.document_version===d.source_document_version
    &&s.status!=='cancelled'&&plain(s.company)&&plain(s.company.identity)&&version(s.company.identity_version)&&version(s.company.fiscal_version)
    &&c.identity_version===s.company.identity_version&&c.fiscal_version===s.company.fiscal_version,'BUSINESS_BASIS_CONFLICT');
  need(s.company.crt==='1'&&s.company.regime_confirmed===true&&s.company.identity.state==='SP','BUSINESS_PROFILE_UNSUPPORTED');
  need(plain(itemEnvelope)&&itemEnvelope.data_mode==='fiscal_item_preparation'&&itemEnvelope.profile==='item-identification-v1'
    &&itemEnvelope.schema_profile===BUSINESS_SCHEMA&&['operational_effects','emission_enabled','can_emit','tax_rules_validated','xsd_validated','catalog_registry_verified'].every(k=>itemEnvelope[k]===false));
  need(plain(taxEnvelope)&&taxEnvelope.data_mode==='fiscal_tax_preparation'&&taxEnvelope.profile==='sn-internal-sale-preparation-v1'
    &&taxEnvelope.schema_profile===BUSINESS_SCHEMA&&['operational_effects','calculation_performed','xml_generated','transmitted','can_emit','tax_rules_validated','xsd_validated'].every(k=>taxEnvelope[k]===false));
  for(const r of[i,t])need(plain(r)&&r.draft_id===d.id&&r.draft_version===d.version&&r.snapshot_hash===d.snapshot_hash&&version(r.version)
    &&r.model===d.model&&r.environment==='2'&&r.source_document_id===d.source_document_id&&r.source_document_version===d.source_document_version
    &&typeof r.created_at==='string'&&r.created_at.length<=40&&/^\d{4}-\d{2}-\d{2}T/.test(r.created_at)&&Number.isFinite(Date.parse(r.created_at)),'BUSINESS_BASIS_CONFLICT');
  need(itemEnvelope.current?.preparation_version===i.version&&itemEnvelope.current.draft_version===d.version&&itemEnvelope.current.matches_current_draft===true
    &&taxEnvelope.current?.tax_version===t.version&&taxEnvelope.current.draft_version===d.version&&taxEnvelope.current.item_preparation_version===i.version
    &&taxEnvelope.current.matches_current_draft===true&&taxEnvelope.current.matches_current_item_preparation===true
    &&taxEnvelope.current.draft_status==='draft'&&taxEnvelope.current.source_status===c.source_status&&taxEnvelope.current.source_changed===false&&taxEnvelope.current.company_changed===false
    &&t.item_preparation_version===i.version&&t.company_identity_version===s.company.identity_version&&t.company_fiscal_version===s.company.fiscal_version
    &&t.crt==='1'&&t.operation==='internal_normal_sale','BUSINESS_BASIS_CONFLICT');
  need(Array.isArray(s.items)&&s.items.length>=1&&s.items.length<=250&&Array.isArray(s.installments)&&s.installments.length<=120
    &&Array.isArray(i.items)&&i.items.length===s.items.length&&Array.isArray(t.items)&&t.items.length===s.items.length);
  // 202610200251: a pedido that adds Total do IPI / Total ICMS ST is outside this Simples profile (no IPI or ST groups are built).
  const taxKeys=['tax_ipi','tax_icms_st'].filter(k=>Object.hasOwn(s,k));
  need(!Object.hasOwn(s,'legacy_taxes')&&taxKeys.every(k=>s[k]==='0.00'),'BUSINESS_PROFILE_UNSUPPORTED');
  let normal;
  try { normal=normalizeDocument('sales_orders',{date:s.date,contact_id:s.contact_id,
    items:s.items.map(v=>pick(v,['id','product_id','description','code','unit','quantity','unit_price','discount_percent'])),
    installments:s.installments.map(v=>pick(v,['due_date','amount','method'])),discount_mode:s.discount_mode,discount_value:s.discount_value,
    freight:s.totals?.freight,other_expenses:s.totals?.other_expenses,notes:s.notes,payment_terms:s.payment_terms,delivery_terms:s.delivery_terms,...pick(s,taxKeys)}); }
  catch { throw new BusinessDocumentError('BUSINESS_INPUT_INVALID'); }
  for(const k of['gross','line_discount','subtotal','discount','freight','other_expenses','total'])need(normal.totals[k]===s.totals[k],'BUSINESS_ARITHMETIC_MISMATCH');
  const seen=new Set();
  for(const [n,v]of s.items.entries()) {
    need(id(v.id)&&!seen.has(v.id)&&v.position===n+1);seen.add(v.id);
    for(const k of['quantity','unit_price','discount_percent','gross','discount','total'])need(normal.items[n][k]===v[k],'BUSINESS_ARITHMETIC_MISMATCH',v.id);
    need(id(v.product_id)&&plain(v.product)&&v.product.id===v.product_id&&version(v.product.version)&&v.product.kind==='P'&&v.product.format==='S','BUSINESS_PROFILE_UNSUPPORTED',v.id);
    const a=i.items[n],b=t.items[n];
    for(const r of[a,b])need(plain(r)&&r.item_id===v.id&&r.position===v.position&&r.product_id===v.product_id,'BUSINESS_BASIS_CONFLICT',v.id);
    need(plain(a.fields)&&exact(b.identifiers,['ncm','origin','cest','gtin','gtin_tax']),'BUSINESS_BASIS_CONFLICT',v.id);
    for(const k of['ncm','origin','cest','gtin','gtin_tax']){
      const f=a.fields[k];need(plain(f)&&f.value===b.identifiers[k]&&plain(f.provenance),'BUSINESS_BASIS_CONFLICT',v.id);
      need(['manual','catalog'].includes(f.provenance.source),'BUSINESS_ITEM_UNPREPARED',v.id);
      if(f.provenance.source==='catalog')need(f.provenance.product_id===v.product_id&&version(f.provenance.product_version)&&f.provenance.active===true,'BUSINESS_ITEM_UNPREPARED',v.id);
    }
  }
  let resolved;
  try{resolved=resolveTaxItems({model:d.model,items:t.items.map(v=>pick(v,['item_id','position','product_id','identifiers'])),decisions:t.items.map(v=>v.decisions)});}
  catch{throw new BusinessDocumentError('BUSINESS_TAX_UNPREPARED');}
  for(let n=0;n<resolved.length;n++)need(equal(resolved[n],pick(t.items[n],['item_id','position','product_id','identifiers','decisions','provenance','pending'])),'BUSINESS_BASIS_CONFLICT');
  return {d,s,i,t};
}
function icms(decision,extra) {
  need(decision!==null&&exact(extra,['credit','groups500']),'BUSINESS_TAX_UNPREPARED');
  if(decision.csosn==='102'){need(extra.credit===null&&extra.groups500===null);return structuredClone(decision);}
  if(decision.csosn==='101'){
    need(decision.credit_rate!==null&&decision.credit_period!==null&&decision.credit_evidence!==null&&exact(extra.credit,['base','amount'])&&extra.groups500===null,'BUSINESS_TAX_UNPREPARED');
    taxAmount(extra.credit.base,decision.credit_rate,extra.credit.amount);
    return {csosn:'101',credit_rate:decision.credit_rate,credit_amount:extra.credit.amount};
  }
  need(decision.csosn==='500'&&extra.credit===null&&exact(extra.groups500,['retention','fcp','effective']),'BUSINESS_TAX_UNPREPARED');
  const result={csosn:'500'};
  for(const group of['retention','fcp','effective']) {
    const selection=extra.groups500[group],v=decision[group];need(['include','omit'].includes(selection),'BUSINESS_GROUP_DECISION_REQUIRED');
    if(selection==='omit'){need(Object.values(v).every(x=>x===null),'BUSINESS_GROUP_DECISION_REQUIRED');result[group]=null;continue;}
    need(Object.entries(v).every(([k,x])=>x!==null||(group==='retention'&&k==='substitute_icms')),'BUSINESS_TAX_UNPREPARED');
    for(const [k,x]of Object.entries(v))if(x!==null){if(k.includes('rate'))rate(x);else money(x);}
    if(group==='fcp'||group==='effective')taxAmount(v.base,v.rate,v.amount);
    result[group]=structuredClone(v);
  }
  return result;
}
/** Shared content checks have no numbering, timestamp, random source or XML dependency. */
function resolveContentData({d,s,i,t},x) {
  need(exact(x,['operation','recipient','items','totals','payments','transport_mode','excluded_groups','homologation_labels','additional_information']));
  need(exact(x.operation,['tpNF','idDest','finNFe','indFinal','indPres'])&&x.operation.tpNF==='1'&&x.operation.idDest==='1'&&x.operation.finNFe==='1'
    &&['0','1'].includes(x.operation.indFinal)&&x.operation.indPres==='1'&&(d.model!=='65'||x.operation.indFinal==='1'),'BUSINESS_PROFILE_UNSUPPORTED');
  need(exact(x.excluded_groups,EXCLUDED)&&EXCLUDED.every(k=>x.excluded_groups[k]==='not_included_in_profile')&&x.homologation_labels==='apply_test_labels','BUSINESS_PROFILE_UNSUPPORTED');
  const e=s.company.identity;
  need(isValidCnpj(e.cnpj)&&typeof e.ie==='string'&&/^[0-9]{2,14}$/.test(e.ie),'BUSINESS_PROFILE_UNSUPPORTED');
  const issuer={cnpj:e.cnpj,name:text(e.legal_name,60,2),trade_name:e.trade_name===null?null:text(e.trade_name,60),ie:e.ie,crt:'1',address:address(e,e.municipality_code)};
  need(plain(s.contact)&&s.contact.id===s.contact_id&&id(s.contact_id)&&version(s.contact.version)&&exact(x.recipient,['municipality_code','indIEDest']),'BUSINESS_RECIPIENT_INVALID');
  const contact=s.contact;
  need(contact.person_type==='J'?isValidCnpj(contact.document):contact.person_type==='F'&&cpf(contact.document),'BUSINESS_RECIPIENT_INVALID');
  text(contact.name,60,2);
  need(['1','2','9'].includes(x.recipient.indIEDest),'BUSINESS_RECIPIENT_INVALID');
  if(x.recipient.indIEDest==='1')need(contact.person_type==='J'&&typeof contact.ie==='string'&&/^[0-9]{2,14}$/.test(contact.ie),'BUSINESS_RECIPIENT_INVALID');
  else need(contact.ie===null,'BUSINESS_RECIPIENT_INVALID');
  if(d.model==='65')need(x.recipient.indIEDest==='9','BUSINESS_PROFILE_UNSUPPORTED');
  const recipient={document_type:contact.person_type==='J'?'CNPJ':'CPF',document:contact.document,name:HOMOLOGATION_RECIPIENT,
    indIEDest:x.recipient.indIEDest,ie:x.recipient.indIEDest==='1'?contact.ie:null,address:address(contact,x.recipient.municipality_code)};
  need(Array.isArray(x.items)&&x.items.length===s.items.length);
  const extras=new Map();
  for(const a of Array.from(x.items)){need(exact(a,['item_id','tributary','allocations','cest_absence','icms'])&&id(a.item_id)&&!extras.has(a.item_id));extras.set(a.item_id,a);}
  let globalDiscount=0n,freight=0n,other=0n,pis=0n,cofins=0n,fcpRet=0n;
  const items=s.items.map((v,n)=>{
    const a=extras.get(v.id),ident=t.items[n].identifiers,choice=t.items[n].decisions;
    need(a,'BUSINESS_BASIS_CONFLICT',v.id);
    need(typeof ident.ncm==='string'&&/^[0-9]{8}$/.test(ident.ncm)&&typeof ident.origin==='string'&&/^[0-8]$/.test(ident.origin),'BUSINESS_ITEM_UNPREPARED',v.id);
    for(const k of['gtin','gtin_tax'])need(ident[k]==='SEM GTIN'||gtinCheckDigitMatches(ident[k]),'BUSINESS_ITEM_UNPREPARED',v.id);
    need(ident.cest===null?a.cest_absence==='omit':typeof ident.cest==='string'&&/^[0-9]{7}$/.test(ident.cest)&&a.cest_absence===null,'BUSINESS_GROUP_DECISION_REQUIRED',v.id);
    need(exact(a.tributary,['unit','quantity','unit_price'])&&exact(a.allocations,['global_discount','freight','other']));
    const q=units(v.quantity,4,11,'BUSINESS_QUANTITY_PRECISION'),p=units(v.unit_price,10,11),qt=units(a.tributary.quantity,4,11,'BUSINESS_QUANTITY_PRECISION'),pt=units(a.tributary.unit_price,10,11);
    need(q.value>0n&&qt.value>0n,'BUSINESS_DECIMAL_INVALID',v.id);
    need(rounded(q.value*p.value,1000000000000n)===money(v.gross)&&rounded(qt.value*pt.value,1000000000000n)===money(v.gross),'BUSINESS_ARITHMETIC_MISMATCH',v.id);
    const gd=money(a.allocations.global_discount),fr=money(a.allocations.freight),ot=money(a.allocations.other),discount=money(v.discount)+gd;
    need(discount<=money(v.gross),'BUSINESS_ARITHMETIC_MISMATCH',v.id);globalDiscount+=gd;freight+=fr;other+=ot;
    need(choice.cfop!==null&&choice.pis!==null&&choice.cofins!==null,'BUSINESS_TAX_UNPREPARED',v.id);
    taxAmount(choice.pis.base,choice.pis.rate,choice.pis.amount);taxAmount(choice.cofins.base,choice.cofins.rate,choice.cofins.amount);
    pis+=money(choice.pis.amount);cofins+=money(choice.cofins.amount);
    const tax=icms(choice.icms,a.icms);if(tax.fcp)fcpRet+=money(tax.fcp.amount);
    return {item_id:v.id,position:v.position,code:text(v.code,60),description:d.model==='65'&&n===0?HOMOLOGATION_PRODUCT:text(v.description,120),
      ncm:ident.ncm,origin:ident.origin,cest:ident.cest,gtin:ident.gtin,gtin_tax:ident.gtin_tax,cfop:choice.cfop,
      unit:text(v.unit,6),quantity:q.lexical,unit_price:p.lexical,tributary:{unit:text(a.tributary.unit,6),quantity:qt.lexical,unit_price:pt.lexical},
      product_amount:v.gross,discount:format(discount),freight:format(fr),other:format(ot),icms:tax,pis:structuredClone(choice.pis),cofins:structuredClone(choice.cofins)};
  });
  need(globalDiscount===money(s.totals.discount)&&freight===money(s.totals.freight)&&other===money(s.totals.other_expenses),'BUSINESS_ARITHMETIC_MISMATCH');
  need(exact(x.totals,TOTAL_FIELDS));for(const k of TOTAL_FIELDS)money(x.totals[k]);
  need(ZERO_FIELDS.every(k=>x.totals[k]==='0.00'),'BUSINESS_PROFILE_UNSUPPORTED');
  const totals={...x.totals};
  for(const [k,value]of Object.entries({vProd:s.totals.gross,vDesc:format(money(s.totals.line_discount)+globalDiscount),vFrete:format(freight),vOutro:format(other),vNF:s.totals.total,vPIS:format(pis),vCOFINS:format(cofins),vFCPSTRet:format(fcpRet)}))need(totals[k]===value,'BUSINESS_ARITHMETIC_MISMATCH');
  need(money(totals.vProd)-money(totals.vDesc)+money(totals.vFrete)+money(totals.vOutro)===money(totals.vNF),'BUSINESS_ARITHMETIC_MISMATCH');
  need(['0','1','2','3','4','9'].includes(x.transport_mode)&&(x.transport_mode!=='9'||freight===0n),'BUSINESS_PROFILE_UNSUPPORTED');
  need(exact(x.payments,['items','change'])&&Array.isArray(x.payments.items)&&x.payments.items.length>=1&&x.payments.items.length<=100,'BUSINESS_PAYMENT_UNSUPPORTED');
  let paid=0n,cash=0n;
  const payments=x.payments.items.map(p=>{
    need(exact(p,['type','timing','amount'])&&['01','15'].includes(p.type)&&['0','1'].includes(p.timing),'BUSINESS_PAYMENT_UNSUPPORTED');
    const amount=money(p.amount);paid+=amount;if(p.type==='01')cash+=amount;
    need(amount>0n,'BUSINESS_PAYMENT_UNSUPPORTED');return {...p};
  });
  const change=money(x.payments.change);
  need(paid===money(totals.vNF)+change&&change<=cash,'BUSINESS_ARITHMETIC_MISMATCH');
  const binding={draft_id:d.id,draft_version:d.version,snapshot_hash:d.snapshot_hash,item_preparation_version:i.version,tax_preparation_version:t.version,
    company_identity_version:s.company.identity_version,company_fiscal_version:s.company.fiscal_version,source_document_id:d.source_document_id,source_document_version:d.source_document_version};
  return {binding,
    operation:{...x.operation,nature:text(d.preparation.operation_nature,60)},issuer,recipient,items,totals,
    transport_mode:x.transport_mode,payments:{items:payments,change:x.payments.change},additional_information:x.additional_information===null?null:text(x.additional_information,2000),
    pending:['ACCOUNTING_REVIEW_REQUIRED','TAX_APPLICABILITY_UNVERIFIED','RTC_APPLICABILITY_UNVERIFIED','PAYMENT_FISCAL_REVIEW_REQUIRED','NUMBERING_NOT_RESERVED',
      'SCHEMA_VALIDATION_REQUIRED','SIGNATURE_REQUIRED',...(d.model==='65'?['NFCE_SUPPLEMENT_REQUIRED']:[]),'CREDENTIAL_AND_TRANSPORT_NOT_AUTHORIZED'],
    transformations:['HOMOLOGATION_RECIPIENT_NAME',...(d.model==='65'?['HOMOLOGATION_FIRST_PRODUCT_DESCRIPTION']:[])],
    arithmetic_profile:'explicit-values-half-up-cent-check-v1'};
}

const completionRecordKeys=['draft_id','version','draft_version','snapshot_hash','item_preparation_version','tax_preparation_version','item_preparation_hash','tax_preparation_hash',
  'model','environment','company_identity_version','company_fiscal_version','source_document_id','source_document_version','created_at','item_basis','completion','pending'];
const basisHashKeys=['draft_record_hash','item_record_hash','tax_record_hash','completion_record_hash'];
function checkCompletion(basis,envelope,hashes) {
  const {d,s,i,t}=basis,r=envelope?.record,c=envelope?.current;
  need(exact(hashes,basisHashKeys)&&basisHashKeys.every(k=>typeof hashes[k]==='string'&&HASH.test(hashes[k])),'BUSINESS_BASIS_CONFLICT');
  need(plain(envelope)&&Object.entries(COMPLETION_FLAGS).every(([k,v])=>envelope[k]===v)&&exact(r,completionRecordKeys)&&plain(c),'BUSINESS_BASIS_CONFLICT');
  need(r.draft_id===d.id&&version(r.version)&&r.draft_version===d.version&&r.snapshot_hash===d.snapshot_hash
    &&r.item_preparation_version===i.version&&r.tax_preparation_version===t.version&&r.model===d.model&&r.environment==='2'
    &&r.source_document_id===d.source_document_id&&r.source_document_version===d.source_document_version
    &&r.company_identity_version===s.company.identity_version&&r.company_fiscal_version===s.company.fiscal_version
    &&r.item_preparation_hash===hashes.item_record_hash&&r.tax_preparation_hash===hashes.tax_record_hash
    &&typeof r.created_at==='string'&&r.created_at.length<=40&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(r.created_at)
    &&validFiscalTimestamp(r.created_at.replace(/\.\d{1,6}(?=Z|[+-]\d{2}:\d{2}$)/,'')),'BUSINESS_BASIS_CONFLICT');
  need(c.completion_version===r.version&&c.draft_version===d.version&&c.draft_status==='draft'
    &&c.source_document_version===d.source_document_version&&c.source_status===s.status&&c.source_changed===false&&c.company_changed===false
    &&c.identity_version===s.company.identity_version&&c.fiscal_version===s.company.fiscal_version
    &&c.item_preparation_version===i.version&&c.tax_preparation_version===t.version
    &&['matches_current_draft','matches_current_item_preparation','matches_current_tax_preparation','matches_current_company'].every(k=>c[k]===true),'BUSINESS_BASIS_CONFLICT');
  const items=t.items.map(v=>({item_id:v.item_id,position:v.position,cest:v.identifiers.cest,csosn:v.decisions.icms?.csosn??null}));
  need(equal(r.item_basis,items),'BUSINESS_BASIS_CONFLICT');
  let checked;try{checked=resolveBusinessCompletion(r.completion,{model:d.model,items});}catch{throw new BusinessDocumentError('BUSINESS_INPUT_INVALID');}
  need(equal(r.pending,checked.pending),'BUSINESS_BASIS_CONFLICT');return r;
}
/**
 * Internal server inputs captured together by 048. Hashes are PostgreSQL record::text
 * digests supplied by that trusted adapter, not recomputed JSONB or authentication.
 * The canonical fingerprint is an array of constrained strings, not a JSONB object.
 */
export function resolveBusinessContent(input) {
  need(exact(input,['draft','itemPreparation','taxPreparation','completionPreparation','basisHashes']));
  const basis=checkBasis(input.draft,input.itemPreparation,input.taxPreparation),r=checkCompletion(basis,input.completionPreparation,input.basisHashes);
  const data=resolveContentData(basis,r.completion),binding={...data.binding,completion_version:r.version,...input.basisHashes};
  const tuple=[BUSINESS_CONTENT_FINGERPRINT_PROFILE,BUSINESS_PROFILE,BUSINESS_SCHEMA,BUSINESS_BUILDER,
    binding.draft_id,String(binding.draft_version),binding.snapshot_hash,binding.draft_record_hash,
    String(binding.item_preparation_version),binding.item_record_hash,String(binding.tax_preparation_version),binding.tax_record_hash,
    String(binding.completion_version),binding.completion_record_hash,String(binding.company_identity_version),String(binding.company_fiscal_version),
    binding.source_document_id,String(binding.source_document_version),basis.d.model,'2'];
  const result=freezeTree({profile:BUSINESS_PROFILE,schema_profile:BUSINESS_SCHEMA,builder:BUSINESS_BUILDER,...BUSINESS_FLAGS,
    identity_assigned:false,numbering_bound:false,xml_generated:false,arithmetic_verified:true,
    ...data,binding,model:basis.d.model,environment:'2',basis_fingerprint_profile:BUSINESS_CONTENT_FINGERPRINT_PROFILE,basis_fingerprint_text:JSON.stringify(tuple)});
  resolvedContents.add(result);return result;
}

/** Local execution proof only. No exported function can register a caller-supplied object. */
export function assertResolvedBusinessContent(value) {
  need(resolvedContents.has(value),'BUSINESS_CONTENT_UNATTESTED');
}

/** Structural identity checks shared by legacy composition and the private 048 binder. Not authorization. */
export function resolveBusinessIdentity(identity,context) {
  need(exact(context,['cnpj','model'])&&isValidCnpj(context.cnpj)&&['55','65'].includes(context.model));
  need(exact(identity,['cUF','cnpj','model','environment','series','number','cNF','issuedAt','tpEmis'])
    &&identity.cUF==='35'&&identity.cnpj===context.cnpj&&identity.model===context.model&&identity.environment==='2'&&identity.tpEmis==='1'
    &&typeof identity.series==='string'&&/^(?:0|[1-9][0-9]{0,2})$/.test(identity.series)&&BigInt(identity.series)<=889n
    &&typeof identity.number==='string'&&/^[1-9][0-9]{0,8}$/.test(identity.number)&&typeof identity.cNF==='string'&&/^[0-9]{8}$/.test(identity.cNF)
    &&validFiscalTimestamp(identity.issuedAt)&&identity.issuedAt.endsWith('-03:00')&&identity.issuedAt.slice(0,4)>='2000'&&identity.issuedAt.slice(0,4)<='2099');
  return {identity:structuredClone(identity),access_key:buildAccessKey(identity)};
}

/** Compatibility composition; the legacy caller still supplies explicit test identity. */
export function resolveBusinessDocument(input) {
  need(exact(input,['draft','itemPreparation','taxPreparation','completion']));
  const basis=checkBasis(input.draft,input.itemPreparation,input.taxPreparation),x=input.completion;
  need(exact(x,['identity','operation','recipient','items','totals','payments','transport_mode','excluded_groups','homologation_labels','additional_information']));
  need(exact(x.identity,['series','number','cNF','issuedAt']));
  const {identity:identityInput,...completion}=x,{binding,...data}=resolveContentData(basis,completion);
  const identity=resolveBusinessIdentity({cUF:'35',cnpj:data.issuer.cnpj,model:basis.d.model,environment:'2',...identityInput,tpEmis:'1'},{cnpj:data.issuer.cnpj,model:basis.d.model});
  return{profile:BUSINESS_PROFILE,schema_profile:BUSINESS_SCHEMA,...BUSINESS_FLAGS,binding,...identity,...data};
}
