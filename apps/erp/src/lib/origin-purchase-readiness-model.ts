export {PURCHASE_READINESS_BASE,PURCHASE_READINESS_RESPONSE_BYTES,capturePurchaseReadinessRequest,purchaseReadinessListPath,purchaseReadinessDetailPath} from './origin-purchase-readiness-request.ts';
import type {ObservedValue,PurchaseReadinessBinding,PurchaseReadinessCapture,PurchaseReadinessIssue} from '../../../../packages/erp-domain/src/origin-purchase-readiness-dto.mjs';
export {parsePurchaseReadinessPage,parsePurchaseReadinessDetail} from '../../../../packages/erp-domain/src/origin-purchase-readiness-dto.mjs';
export type {ObservedValue,PurchaseReadinessPage,PurchaseReadinessDetail,PurchaseReadinessSource,PurchaseReadinessBinding} from '../../../../packages/erp-domain/src/origin-purchase-readiness-dto.mjs';

/** Observed decimals stay textual; this display does not round or approve an amount. */
export function purchaseObservedDecimal(value:string|null,currency=false){
 if(value===null)return 'Não informado';
 if(typeof value!=='string'||value.length>256||/[\r\n]/.test(value)||! /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value))throw new Error('PURCHASE_READINESS_RESPONSE_INVALID');
 const [integer,fraction]=value.split('.'),formatted=integer.replace(/\B(?=(\d{3})+(?!\d))/g,'.')+(fraction===undefined?'':','+fraction);
 return (currency?'R$ ':'')+formatted;
}
export function purchaseReadinessDay(value:string|null){return value===null?'Não informada':value.split('-').reverse().join('/');}
export function purchaseReadinessMoment(value:string|null){return value===null?'Não informada':new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'});}
export const PURCHASE_STATUS_LABELS:Record<string,string>={'0':'Em aberto','1':'Atendido','2':'Cancelado','3':'Em andamento'};

export function purchaseObserved(value:ObservedValue,format:'text'|'decimal'|'money'|'date'='text'){
 if(value.state==='absent')return 'Não informado na origem';
 if(value.state==='null')return 'Sem valor declarado';
 if(value.state==='invalid')return 'Formato não suportado para conferência';
 const text=value.value!;
 if(format==='decimal'||format==='money')return purchaseObservedDecimal(text,format==='money');
 // A source date is evidence, including a zero/invalid date. Do not normalize it.
 if(format==='date'&&/^\d{4}-\d{2}-\d{2}$/.test(text)&&text!=='0000-00-00')return purchaseReadinessDay(text);
 return text||'Campo vazio na origem';
}
export function purchaseSituation(value:ObservedValue){return value.state==='value'?(PURCHASE_STATUS_LABELS[value.value!]??`Situação ${value.value} ainda não classificada`):purchaseObserved(value);}
export const purchaseCaptureLabels:Record<PurchaseReadinessCapture['state'],string>={absent:'Captura exata de preços ainda não registrada',other_profile:'Captura exata de preços não disponível para esta compra',unbound:'Captura de preços não corresponde à observação atual',bound:'Preços unitários com captura exata da observação atual'};
export function purchaseBindingLabel(binding:PurchaseReadinessBinding){
 return ({current:'Correspondência atual conferida',invalid_id:'Identificador da origem ausente ou inválido',missing_staging:'Cadastro da origem ainda não observado',missing_native:'Sem cadastro correspondente no FAGOO',needs_review:'Correspondência precisa de revisão'} as const)[binding.state];
}
export const purchasePendingLabels:Record<string,string>={
 SOURCE_STATUS_REVIEW:'Definir quais situações de compra podem ser adotadas.',
 SOURCE_EFFECTS_NOT_PROVEN:'Conferir recebimentos, estoque e lançamentos financeiros já feitos na origem.',
 COMMERCIAL_MATH_NOT_RECONCILED:'Conciliar preços, descontos, frete, impostos e parcelas.',
 PERMANENT_PURCHASE_ORIGIN_NOT_IMPLEMENTED:'Concluir o vínculo permanente que impedirá importar a mesma compra novamente.',
};
const issueLabels:Record<string,string>={
 SOURCE_TOO_LARGE:'O conteúdo excede o limite de conferência.',SOURCE_ID_MISMATCH:'O identificador do conteúdo não corresponde ao registro observado.',
 PRICE_CAPTURE_CURRENT_MISSING:'Falta uma captura exata dos preços vinculada a esta observação.',SOURCE_STATUS_UNREVIEWED:'A situação observada precisa de revisão.',SOURCE_DATE_INVALID:'A data da origem precisa de revisão.',
 SUPPLIER_BINDING_UNAVAILABLE:'A correspondência do fornecedor ainda não está conferida.',ITEM_COUNT_OUTSIDE_LIMIT:'A quantidade de itens está fora do limite de 1 a 250.',ITEM_INVALID:'O formato deste item precisa de revisão.',
 PRODUCT_BINDING_UNAVAILABLE:'A correspondência do produto ainda não está conferida.',PRICE_OUTSIDE_NATIVE_LIMIT:'O preço não cabe nos limites atuais do cadastro de compras.',QUANTITY_OUTSIDE_NATIVE_LIMIT:'A quantidade não cabe nos limites atuais do cadastro de compras.',
 UNIT_INVALID:'A unidade está ausente ou em formato não suportado.',UNIT_DIFFERS_FROM_LINK:'A unidade observada difere da unidade do cadastro correspondente.',INVOICE_REFERENCE_UNVERIFIED:'A referência de nota fiscal não foi conferida.',
 TEXT_OUTSIDE_DISPLAY_LIMIT:'Um texto excede os limites de exibição.',COMMERCIAL_VALUE_UNAVAILABLE:'Um valor comercial está ausente ou em formato não suportado.',
};
export function purchaseIssueLabel(issue:PurchaseReadinessIssue){return`${issue.position===null?'':`Item ${issue.position}: `}${issueLabels[issue.code]??'Uma informação precisa de revisão.'}`;}
