/** Preparation diagnostics only: no tax defaults, XML, numbering or transport. */
import {normalizeDocument} from '../../erp-domain/src/index.mjs';
import {isValidCnpj} from './identity.mjs';
const ID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const version=v=>Number.isSafeInteger(v)&&v>=1&&v<=2147483647;
const validId=v=>typeof v==='string'&&ID.test(v);
const fail=()=>{throw new Error('FISCAL_REVIEW_INPUT_INVALID');};
const need=test=>{if(!test)fail();};
const pick=(v,keys)=>Object.fromEntries(keys.map(k=>[k,v[k]]));
const fields={name:200,code:100,unit:16,kind:1,format:1,ncm:8,gtin:14,origin:1,cest:7,gtin_tax:14};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const safeText=(v,max)=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u001F\u007F]/.test(v);
export const FISCAL_REVIEW_PROFILE='sp-homologation-data-review-v1';
export const FISCAL_REVIEW_SCHEMA='pl010f-v1.04';
export const FISCAL_REVIEW_FLAGS=Object.freeze({read_only:true,operational_effects:false,emission_enabled:false,can_emit:false,tax_rules_validated:false,xsd_validated:false});
// Limits are observed in the pinned XSD. Passing them is not fiscal validation.
export const FISCAL_REVIEW_LIMITS=Object.freeze({description:120,code:60,unit:6,name:60,quantity_scale:4,quantity_integers:11,price_scale:10,price_integers:11});
export const FISCAL_REVIEW_LABELS=Object.freeze({
 DRAFT_ARCHIVED:'Revisão de um rascunho arquivado; disponível somente para conferência.',
 HISTORICAL_REVISION:'Há uma revisão mais recente do rascunho. Este relatório permanece vinculado à revisão selecionada.',
 SOURCE_CHANGED:'O pedido mudou desde a cópia; conferir as versões antes de preparar os dados fiscais.',
 SOURCE_CANCELLED:'O pedido de origem está cancelado.',
 COMPANY_CHANGED:'O cadastro da empresa mudou desde a cópia.',
 COMPANY_MISSING:'A identidade da empresa não foi capturada nesta revisão.',
 COMPANY_NAME_LIMIT:'Razão social fora do limite de 2 a 60 caracteres do perfil XML.',
 COMPANY_CNPJ_INVALID:'CNPJ da empresa incompatível com a verificação estrutural local.',
 COMPANY_STATE_OUTSIDE_PROFILE:'A empresa está fora do perfil SP desta preparação.',
 COMPANY_IE_MISSING:'Inscrição estadual da empresa não informada.',
 COMPANY_IE_UNVERIFIED:'Inscrição estadual não foi validada cadastralmente.',
 REGIME_UNCONFIRMED:'Regime tributário ainda não confirmado; nenhum enquadramento foi escolhido.',
 OPERATION_NATURE_MISSING:'Natureza da operação não informada.',
 OPERATION_NATURE_LIMIT:'Natureza da operação fora do limite de 1 a 60 caracteres do perfil XML.',
 OPERATION_SCOPE_UNMAPPED:'Finalidade, destino, consumidor final e presença precisam de definição fiscal explícita.',
 NFCE_OPERATION_UNREVIEWED:'A operação do modelo 65 precisa de conferência própria; selecionar NFC-e não determina sua elegibilidade.',
 RECIPIENT_DOCUMENT_MISSING:'Documento do destinatário não informado nesta cópia.',
 RECIPIENT_DOCUMENT_FORMAT:'Documento do destinatário precisa de conferência de formato e tipo de pessoa.',
 RECIPIENT_NAME_LIMIT:'Nome do destinatário fora do limite de 2 a 60 caracteres do perfil XML.',
 RECIPIENT_ADDRESS_INCOMPLETE:'Endereço do destinatário incompleto na cópia; conferir sua exigência na operação.',
 RECIPIENT_MUNICIPALITY_UNMAPPED:'Código IBGE do destinatário não foi capturado; não será inferido pelo nome da cidade.',
 RECIPIENT_TAX_STATUS_UNMAPPED:'Indicador fiscal do destinatário e inscrição estadual precisam de definição explícita.',
 TEXT_CHARACTERS_OUTSIDE_SCHEMA:'Texto contém caracteres ou espaços de borda fora do tipo TString do XSD local; não será corrigido silenciosamente.',
 ITEM_DESCRIPTION_LIMIT:'Descrição do item fora do limite de 1 a 120 caracteres do perfil XML.',
 ITEM_CODE_MISSING:'Código fiscal/comercial do item não informado; não será inventado a partir de outro campo.',
 ITEM_CODE_LIMIT:'Código do item excede o limite de 60 caracteres do perfil XML.',
 ITEM_UNIT_LIMIT:'Unidade comercial fora do limite de 1 a 6 caracteres do perfil XML.',
 ITEM_QUANTITY_PRECISION:'Quantidade não cabe em até quatro casas decimais sem perda; conferir a unidade e o valor.',
 ITEM_PRICE_PRECISION:'Preço unitário excede os limites decimais do perfil XML.',
 ITEM_FREE_REQUIRES_FISCAL_DATA:'Item livre exige dados fiscais próprios em etapa futura; não será transformado automaticamente em produto.',
 ITEM_KIND_OUTSIDE_PROFILE:'O item não está identificado como produto físico na cópia do pedido; exige tratamento fiscal próprio.',
 ITEM_FORMAT_REQUIRES_REVIEW:'Variação ou composição exige conferência fiscal própria; não será desmembrada automaticamente.',
 ITEM_NCM_MISSING:'NCM não informado na cópia do produto.',
 ITEM_NCM_FORMAT:'Formato de NCM incompatível com os formatos de dois ou oito dígitos do XSD local.',
 ITEM_NCM_OUTSIDE_PRODUCT_PROFILE:'NCM de dois dígitos exige análise de exceção; este perfil de produtos não presume sua aplicação.',
 NCM_CLASSIFICATION_UNVERIFIED:'A classificação e a vigência do NCM não foram verificadas; formato correto não confirma enquadramento.',
 ITEM_GTIN_FORMAT:'GTIN informado fora dos formatos previstos no XSD local.',
 GTIN_DECISION_REQUIRED:'Ausência de GTIN não será convertida automaticamente em SEM GTIN.',
 GTIN_REGISTRY_UNVERIFIED:'GTIN não foi conferido em cadastro externo nem vinculado fiscalmente ao produto.',
 ITEM_ORIGIN_NOT_CAPTURED:'Origem da mercadoria não foi capturada nesta revisão; valor atual do cadastro não substitui o histórico.',
 ITEM_CEST_APPLICABILITY_UNREVIEWED:'Aplicabilidade de CEST e seu registro fiscal precisam de conferência; não é presumido obrigatório para todo item.',
 ITEM_TRIBUTARY_FIELDS_UNMAPPED:'Unidade, quantidade, preço e GTIN tributários precisam de mapeamento explícito.',
 ITEM_TAX_MAPPING_UNREVIEWED:'CFOP, CST/CSOSN e grupos tributários do item não foram definidos nem calculados.',
 CATALOG_CHANGED:'O cadastro atual do produto está em outra versão; os valores históricos não foram substituídos.',
 CATALOG_UNAVAILABLE:'O cadastro atual do produto não está disponível para comparação.',
 CATALOG_INACTIVE:'O produto está inativo no cadastro atual; conferir antes de uma nova preparação.',
 ORDER_TAXES_OUTSIDE_PROFILE:'O pedido soma Total do IPI ou Total ICMS ST ao total; este emissor de homologação ainda não monta os grupos de IPI e de ICMS ST. Use Vendas › Notas fiscais de saída para essa venda.',
 COMMERCIAL_ALLOCATION_UNREVIEWED:'Desconto global, frete ou outras despesas exigem mapeamento fiscal por item; nenhum rateio foi aplicado.',
 PAYMENT_FISCAL_MAPPING_REQUIRED:'Parcelas e nomes de formas de pagamento não definem automaticamente os códigos e grupos fiscais.',
 TAX_REVIEW_REQUIRED:'Revisão tributária das operações ainda necessária; nenhum tributo foi calculado.',
 XML_PIPELINE_PENDING:'Geração do XML deste rascunho, validação XSD e assinatura ainda não foram realizadas.',
 EMISSION_DEPENDENCIES_PENDING:'Certificado/cofre, credenciamento, perfil vigente, comunicação e testes efetivos de homologação permanecem dependências da emissão.',
});

/** Returns an exact lexical representation or null; never rounds nonzero digits. */
export function fiscalExactDecimal(value,scale,integers){
 if(typeof value!=='string'||value.length>64||!Number.isInteger(scale)||scale<0||scale>10||!Number.isInteger(integers)||integers<1||integers>13)return null;
 if(!/^(0|[1-9]\d*)(?:\.\d+)?$/.test(value))return null;
 const[whole,fraction='']=value.split('.'),trimmed=fraction.replace(/0+$/,'');
 if(whole.length>integers||trimmed.length>scale)return null;
 return trimmed?whole+'.'+trimmed:whole;
}
/**
 * 202610200251: Total do IPI / Total ICMS ST of the pedido (documentos 196) travel with the copy (tax_ipi / tax_icms_st and the totals
 * ipi / icms_st); a copy made before 251 has them only inside the total (legacy_taxes, never split). Same reading as the Worker.
 */
const CENTS=/^\d{1,13}\.\d{2}$/;
function orderTaxes(s){
 const keys=['tax_ipi','tax_icms_st'].filter(k=>Object.hasOwn(s,k)),split=Object.hasOwn(s.totals,'ipi')||Object.hasOwn(s.totals,'icms_st');
 need(keys.every(k=>typeof s[k]==='string'&&CENTS.test(s[k]))&&(keys.length?split:!split));
 if(Object.hasOwn(s,'legacy_taxes')){need(!keys.length&&typeof s.legacy_taxes==='string'&&CENTS.test(s.legacy_taxes)&&s.legacy_taxes!=='0.00');return{input:{tax_ipi:s.legacy_taxes},fields:{legacy_taxes:s.legacy_taxes},split:false,amount:s.legacy_taxes};}
 if(!keys.length)return{input:{},fields:{},split:false,amount:'0.00'};
 const fields=Object.fromEntries(keys.map(k=>[k,s[k]])),total=String(keys.reduce((sum,k)=>sum+BigInt(s[k].replace('.','')),0n)).padStart(3,'0');
 return{input:fields,fields,split:true,amount:total.slice(0,-2)+'.'+total.slice(-2)};
}
function normalizeBasis(input){
 need(object(input)&&object(input.draft)&&input.draft.data_mode==='fiscal_draft'&&input.draft.emission_enabled===false&&input.draft.operational_effects===false);
 const d=input.draft,r=d.record,s=r?.snapshot,c=d.current;
 need(object(r)&&validId(r.id)&&version(r.version)&&['draft','archived'].includes(r.status)&&['55','65'].includes(r.model)&&r.environment==='2'&&HASH.test(r.snapshot_hash||''));
 need(object(s)&&s.catalog_basis==='document_snapshot'&&validId(r.source_document_id)&&s.document_id===r.source_document_id&&version(r.source_document_version)&&s.document_version===r.source_document_version&&s.kind==='sales_orders');
 need(object(c)&&version(c.version)&&c.version>=r.version&&['draft','archived'].includes(c.status)&&version(c.source_document_version)&&typeof c.source_changed==='boolean'&&typeof c.company_changed==='boolean'
  &&c.source_changed===(c.source_document_version!==r.source_document_version));
 need(Array.isArray(s.items)&&s.items.length>=1&&s.items.length<=250&&Array.isArray(s.installments)&&s.installments.length<=120&&object(s.totals)&&object(s.contact)&&object(r.preparation));
 const taxes=orderTaxes(s);
 const normalized=normalizeDocument('sales_orders',{date:s.date,contact_id:s.contact_id,items:s.items.map(i=>pick(i,['id','product_id','description','code','unit','quantity','unit_price','discount_percent'])),
  installments:s.installments.map(i=>pick(i,['due_date','amount','method'])),discount_mode:s.discount_mode,discount_value:s.discount_value,freight:s.totals.freight,other_expenses:s.totals.other_expenses,notes:s.notes,payment_terms:s.payment_terms,delivery_terms:s.delivery_terms,...taxes.input});
 for(const key of['gross','line_discount','subtotal','discount','freight','other_expenses','total',...(taxes.split?['ipi','icms_st']:[])])need(normalized.totals[key]===s.totals[key]);
 need(validId(s.contact.id)&&s.contact.id===s.contact_id&&version(s.contact.version)&&typeof s.contact.name==='string');
 const productIds=new Set(),itemIds=new Set();
 s.items.forEach((i,index)=>{
  need(validId(i.id)&&!itemIds.has(i.id)&&i.position===index+1);itemIds.add(i.id);
  for(const key of['quantity','unit_price','discount_percent','gross','discount','total'])need(normalized.items[index][key]===i[key]);
  if(i.product_id===null)need(i.product===null);
  else{need(validId(i.product_id)&&object(i.product)&&i.product.id===i.product_id&&version(i.product.version));productIds.add(i.product_id);}
 });
 need(typeof input.observed_at==='string'&&input.observed_at.length<=40&&/^\d{4}-\d{2}-\d{2}T/.test(input.observed_at)&&Number.isFinite(Date.parse(input.observed_at)));
 need(Array.isArray(input.catalog)&&input.catalog.length===productIds.size);
 const expected=[...productIds].sort();const catalog=input.catalog.map((entry,index)=>{
  need(object(entry)&&entry.product_id===expected[index]);if(entry.record===null)return{product_id:entry.product_id,record:null};
  const p=entry.record;need(object(p)&&p.id===entry.product_id&&version(p.version)&&typeof p.active==='boolean');
  const result={id:p.id,version:p.version,active:p.active};
  for(const[key,max]of Object.entries(fields)){need(p[key]===null||safeText(p[key],max));result[key]=p[key];}
  need(typeof p.name==='string'&&p.name.length>0);
  need(p.origin===null||/^[0-8]$/.test(p.origin));need(p.cest===null||/^\d{7}$/.test(p.cest));
  need(p.gtin_tax===null||/^(?:\d{8}|\d{12,14}|SEM GTIN)$/.test(p.gtin_tax));
  for(const item of s.items.filter(i=>i.product_id===p.id)){
   need(p.version>=item.product.version);
   if(p.version===item.product.version)for(const key of['name','code','unit','kind','format','ncm','gtin'])need(p[key]===item.product[key]);
  }
  return{product_id:entry.product_id,record:result};
 });
 const companyKeys=['legal_name','trade_name','cnpj','ie','postal_code','street','number','complement','district','city','municipality_code','state'];
 need(s.company===null||object(s.company)&&object(s.company.identity));
 const company=s.company===null?null:{...pick(s.company,['identity_version','fiscal_version','crt','regime_confirmed']),identity:pick(s.company.identity,companyKeys)};
 need(c.company_changed===((c.identity_version!==(company?.identity_version??null))||(c.fiscal_version!==(company?.fiscal_version??null))));
 need(Array.isArray(d.pending)&&d.pending.length<=40&&d.pending.every(code=>typeof code==='string'&&/^[A-Z_]{1,80}$/.test(code)));
 const snapshot={...pick(s,['catalog_basis','document_id','document_version','kind','number','status','date','contact_id','discount_mode','discount_value','notes','payment_terms','delivery_terms']),
  contact:pick(s.contact,['id','version','name','person_type','document','ie','postal_code','street','number','complement','district','city','state']),
  items:s.items.map(i=>({...pick(i,['id','position','product_id','description','code','unit','quantity','unit_price','discount_percent','gross','discount','total']),
   product:i.product===null?null:pick(i.product,['id','version','name','code','unit','kind','format','ncm','gtin'])})),
  totals:pick(s.totals,['gross','line_discount','subtotal','discount','freight','other_expenses','total',...(taxes.split?['ipi','icms_st']:[])]),
  installments:s.installments.map(i=>pick(i,['position','due_date','amount','method'])),company,...taxes.fields};
 const draft={data_mode:'fiscal_draft',emission_enabled:false,operational_effects:false,
  record:{...pick(r,['id','model','environment','status','version','source_document_id','source_document_version','snapshot_hash','created_at','updated_at','archived_at','archive_reason']),
   preparation:pick(r.preparation,['operation_nature','notes']),snapshot},
  current:pick(c,['version','status','source_document_version','source_status','identity_version','fiscal_version','source_changed','company_changed']),pending:[...d.pending]};
 return{draft,catalog,observed_at:input.observed_at};
}

export function buildFiscalReview(input){
 const basis=normalizeBasis(input),d=basis.draft,r=d.record,s=r.snapshot,current=d.current,findings=[];
 const add=(code,scope,field,severity='blocking',source='snapshot',item=null)=>findings.push({code,scope,field,severity,source,item_id:item?.id??null,position:item?.position??null});
 const checkText=(value,max,code,scope,field,item=null,min=1)=>{
  if(typeof value!=='string'||[...value].length<min||[...value].length>max)add(code,scope,field,'blocking','snapshot',item);
  if(typeof value==='string'&&value.length&&!/^(?:[!-ÿ]|[!-ÿ][ -ÿ]*[!-ÿ])$/.test(value))add('TEXT_CHARACTERS_OUTSIDE_SCHEMA',scope,field,'blocking','snapshot',item);
 };
 if(current.status==='archived')add('DRAFT_ARCHIVED','document','status');
 if(current.version!==r.version)add('HISTORICAL_REVISION','document','version','review','comparison');
 if(current.source_changed)add('SOURCE_CHANGED','document','source_document_version','review','comparison');
 if(current.source_status==='cancelled')add('SOURCE_CANCELLED','document','source_status','blocking','comparison');
 if(current.company_changed)add('COMPANY_CHANGED','issuer','company','review','comparison');
 if(!s.company)add('COMPANY_MISSING','issuer','identity');
 else{
  const company=s.company.identity;need(object(company));
  checkText(company.legal_name,60,'COMPANY_NAME_LIMIT','issuer','legal_name',null,2);
  if(!isValidCnpj(company.cnpj))add('COMPANY_CNPJ_INVALID','issuer','cnpj');
  if(company.state!=='SP')add('COMPANY_STATE_OUTSIDE_PROFILE','issuer','state');
  if(!company.ie)add('COMPANY_IE_MISSING','issuer','ie');
  else add('COMPANY_IE_UNVERIFIED','issuer','ie','review');
 }
 if(!s.company?.regime_confirmed||!['1','2','3','4'].includes(s.company?.crt))add('REGIME_UNCONFIRMED','issuer','crt');
 if(!r.preparation.operation_nature)add('OPERATION_NATURE_MISSING','document','operation_nature');
 else checkText(r.preparation.operation_nature,60,'OPERATION_NATURE_LIMIT','document','operation_nature');
 add('OPERATION_SCOPE_UNMAPPED','document','fiscal_operation','review','pipeline');
 if(r.model==='65')add('NFCE_OPERATION_UNREVIEWED','document','model','review','pipeline');
 const contact=s.contact;
 checkText(contact.name,60,'RECIPIENT_NAME_LIMIT','recipient','name',null,2);
 if(!contact.document)add('RECIPIENT_DOCUMENT_MISSING','recipient','document');
 else if(contact.person_type==='J'?!isValidCnpj(contact.document):contact.person_type==='F'?!/^\d{11}$/.test(contact.document):true)add('RECIPIENT_DOCUMENT_FORMAT','recipient','document');
 if(['postal_code','street','number','district','city','state'].some(k=>!contact[k]))add('RECIPIENT_ADDRESS_INCOMPLETE','recipient','address','review');
 add('RECIPIENT_MUNICIPALITY_UNMAPPED','recipient','municipality_code','review','pipeline');
 add('RECIPIENT_TAX_STATUS_UNMAPPED','recipient','indIEDest','review','pipeline');
 const products=new Map(basis.catalog.map(p=>[p.product_id,p.record]));
 const items=s.items.map(item=>{
  checkText(item.description,120,'ITEM_DESCRIPTION_LIMIT','item','description',item);
  if(!item.code)add('ITEM_CODE_MISSING','item','code','blocking','snapshot',item);
  else checkText(item.code,60,'ITEM_CODE_LIMIT','item','code',item);
  checkText(item.unit,6,'ITEM_UNIT_LIMIT','item','unit',item);
  const quantity=fiscalExactDecimal(item.quantity,4,11),price=fiscalExactDecimal(item.unit_price,10,11);
  if(quantity===null)add('ITEM_QUANTITY_PRECISION','item','quantity','blocking','snapshot',item);
  if(price===null)add('ITEM_PRICE_PRECISION','item','unit_price','blocking','snapshot',item);
  const p=item.product;
  if(!p)add('ITEM_FREE_REQUIRES_FISCAL_DATA','item','product_id','blocking','snapshot',item);
  else{
   if(p.kind!=='P')add('ITEM_KIND_OUTSIDE_PROFILE','item','kind','blocking','snapshot',item);
   if(p.format!=='S')add('ITEM_FORMAT_REQUIRES_REVIEW','item','format','blocking','snapshot',item);
   if(!p.ncm)add('ITEM_NCM_MISSING','item','ncm','blocking','snapshot',item);
   else if(!/^(?:\d{2}|\d{8})$/.test(p.ncm))add('ITEM_NCM_FORMAT','item','ncm','blocking','snapshot',item);
   else if(p.ncm.length===2)add('ITEM_NCM_OUTSIDE_PRODUCT_PROFILE','item','ncm','review','snapshot',item);
   add('NCM_CLASSIFICATION_UNVERIFIED','item','ncm','review','snapshot',item);
   if(!p.gtin)add('GTIN_DECISION_REQUIRED','item','gtin','review','snapshot',item);
   else if(!/^(?:\d{8}|\d{12,14}|SEM GTIN)$/.test(p.gtin))add('ITEM_GTIN_FORMAT','item','gtin','blocking','snapshot',item);
   else if(p.gtin!=='SEM GTIN')add('GTIN_REGISTRY_UNVERIFIED','item','gtin','review','snapshot',item);
  }
  add('ITEM_ORIGIN_NOT_CAPTURED','item','origin','blocking','pipeline',item);
  add('ITEM_CEST_APPLICABILITY_UNREVIEWED','item','cest','review','pipeline',item);
  add('ITEM_TRIBUTARY_FIELDS_UNMAPPED','item','tributary_fields','blocking','pipeline',item);
  add('ITEM_TAX_MAPPING_UNREVIEWED','item','taxes','review','pipeline',item);
  const currentProduct=item.product_id===null?null:products.get(item.product_id);
  if(item.product_id!==null){
   if(!currentProduct)add('CATALOG_UNAVAILABLE','item','product_id','review','current_catalog',item);
   else{
    if(currentProduct.version!==p.version)add('CATALOG_CHANGED','item','product_version','review','comparison',item);
    if(!currentProduct.active)add('CATALOG_INACTIVE','item','active','review','current_catalog',item);
   }
  }
  return{item_id:item.id,position:item.position,quantity_lexical:quantity,unit_price_lexical:price,
   catalog_state:item.product_id===null?'unlinked':!currentProduct?'unavailable':currentProduct.version===p.version?'same_version':'changed'};
 });
 if(['discount','freight','other_expenses'].some(k=>s.totals[k]!=='0.00'))add('COMMERCIAL_ALLOCATION_UNREVIEWED','document','allocations','review','pipeline');
 // 202610200251: this homologation emitter builds only the Simples groups without IPI or ICMS ST.
 if(orderTaxes(s).amount!=='0.00')add('ORDER_TAXES_OUTSIDE_PROFILE','document','taxes');
 add('PAYMENT_FISCAL_MAPPING_REQUIRED','payments','installments','review','pipeline');
 add('TAX_REVIEW_REQUIRED','dependencies','taxes','review','pipeline');
 add('XML_PIPELINE_PENDING','dependencies','xml','review','pipeline');
 add('EMISSION_DEPENDENCIES_PENDING','dependencies','emission','review','pipeline');
 need(findings.length<=6000);
 return{data_mode:'fiscal_review',...FISCAL_REVIEW_FLAGS,basis,report:{profile:FISCAL_REVIEW_PROFILE,schema_profile:FISCAL_REVIEW_SCHEMA,
  summary:{items:items.length,blocking:findings.filter(f=>f.severity==='blocking').length,review:findings.filter(f=>f.severity==='review').length},findings,items}};
}

/** Browser boundary recomputes deterministic diagnostics and discards extra fields. */
export function validateFiscalReview(value,expectedId,expectedRevision){
 need(object(value)&&value.data_mode==='fiscal_review'&&Object.entries(FISCAL_REVIEW_FLAGS).every(([key,flag])=>value[key]===flag));
 const normalized=buildFiscalReview(value.basis);
 need(normalized.basis.draft.record.id===expectedId&&normalized.basis.draft.record.version===expectedRevision);
 need(same(value.report,normalized.report));return normalized;
}
