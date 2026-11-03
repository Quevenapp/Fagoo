export {SALES_READINESS_BASE,SALES_READINESS_RESPONSE_BYTES,captureSalesReadinessRequest,salesReadinessListPath,salesReadinessDetailPath} from './origin-sales-readiness-request.ts';
import type {ObservedValue,SalesReadinessBinding,SalesReadinessCapture,SalesReadinessIssue} from '../../../../packages/erp-domain/src/origin-sales-readiness-dto.mjs';
export {parseSalesReadinessPage,parseSalesReadinessDetail} from '../../../../packages/erp-domain/src/origin-sales-readiness-dto.mjs';
export type {ObservedValue,SalesReadinessPage,SalesReadinessDetail,SalesReadinessSource,SalesReadinessBinding} from '../../../../packages/erp-domain/src/origin-sales-readiness-dto.mjs';

/** Observed decimals stay textual; this display does not round or approve an amount. */
export function salesObservedDecimal(value:string|null,currency=false){
 if(value===null)return 'Não informado';
 if(typeof value!=='string'||value.length>256||/[\r\n]/.test(value)||! /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value))throw new Error('SALES_READINESS_RESPONSE_INVALID');
 const [integer,fraction]=value.split('.'),formatted=integer.replace(/\B(?=(\d{3})+(?!\d))/g,'.')+(fraction===undefined?'':','+fraction);
 return (currency?'R$ ':'')+formatted;
}
export function salesReadinessDay(value:string|null){return value===null?'Não informada':value.split('-').reverse().join('/');}
export function salesReadinessMoment(value:string|null){return value===null?'Não informada':new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'});}
// Sales situation codes are observed values, without labels inferred from purchases.

export function salesObserved(value:ObservedValue,format:'text'|'decimal'|'money'|'date'='text'){
 if(value.state==='absent')return 'Não informado na origem';
 if(value.state==='null')return 'Sem valor declarado';
 if(value.state==='invalid')return 'Formato não suportado para conferência';
 const text=value.value!;
 if(format==='decimal'||format==='money')return salesObservedDecimal(text,format==='money');
 // A source date is evidence, including a zero/invalid date. Do not normalize it.
 if(format==='date'&&/^\d{4}-\d{2}-\d{2}$/.test(text)&&text!=='0000-00-00')return salesReadinessDay(text);
 return text||'Campo vazio na origem';
}
export function salesSituation(value:ObservedValue){return value.state==='value'?`Código observado ${value.value} · situação ainda não classificada`:salesObserved(value);}
export const salesCaptureLabels:Record<SalesReadinessCapture['state'],string>={absent:'Captura exata de preços ainda não registrada',other_profile:'Captura exata de preços não disponível para esta venda',unbound:'Captura de preços não corresponde à observação atual',bound:'Captura numérica de preços conferida para esta observação'};
export function salesBindingLabel(binding:SalesReadinessBinding){
 return ({current:'Correspondência atual conferida',invalid_id:'Identificador da origem ausente ou inválido',missing_staging:'Cadastro da origem ainda não observado',missing_native:'Sem cadastro correspondente no FAGOO',needs_review:'Correspondência precisa de revisão'} as const)[binding.state];
}
export const salesPendingLabels:Record<string,string>={
 SOURCE_STATUS_REVIEW:'Definir quais situações de venda podem ser adotadas.',
 SOURCE_EFFECTS_NOT_PROVEN:'Conferir entregas, estoque e lançamentos financeiros já feitos na origem.',
 COMMERCIAL_MATH_NOT_RECONCILED:'Conciliar preços, descontos, frete, impostos e parcelas.',
 PERMANENT_SALES_ORIGIN_NOT_IMPLEMENTED:'Concluir o vínculo permanente que impedirá importar a mesma venda novamente.',
 HISTORICAL_EFFECT_GUARD_NOT_IMPLEMENTED:'Impedir que pedidos históricos voltem a gerar estoque, cobranças ou notas fiscais.',
};
const issueLabels:Record<string,string>={
 SOURCE_TOO_LARGE:'O conteúdo excede o limite de conferência.',SOURCE_ID_MISMATCH:'O identificador do conteúdo não corresponde ao registro observado.',
 PRICE_CAPTURE_CURRENT_MISSING:'Falta uma captura exata dos preços vinculada a esta observação.',SOURCE_STATUS_UNREVIEWED:'A situação observada precisa de revisão.',SOURCE_DATE_INVALID:'A data da origem precisa de revisão.',
 CUSTOMER_BINDING_UNAVAILABLE:'A correspondência do cliente ainda não está conferida.',ITEM_COUNT_OUTSIDE_LIMIT:'A quantidade de itens está fora do limite de 1 a 250.',ITEM_INVALID:'O formato deste item precisa de revisão.',
 PRODUCT_BINDING_UNAVAILABLE:'A correspondência do produto ainda não está conferida.',PRICE_OUTSIDE_NATIVE_LIMIT:'O preço não cabe nos limites atuais do cadastro de vendas.',QUANTITY_OUTSIDE_NATIVE_LIMIT:'A quantidade não cabe nos limites atuais do cadastro de vendas.',
 UNIT_INVALID:'A unidade está ausente ou em formato não suportado.',UNIT_DIFFERS_FROM_LINK:'A unidade observada difere da unidade do cadastro correspondente.',INVOICE_REFERENCE_UNVERIFIED:'A referência de nota fiscal não foi conferida.',
 LINE_DISCOUNT_OUTSIDE_OBSERVED_PERCENT_LIMIT:'O desconto observado excede o limite numérico inspecionado; a fórmula permanece pendente.',TEXT_OUTSIDE_DISPLAY_LIMIT:'Um texto excede os limites de exibição.',COMMERCIAL_VALUE_UNAVAILABLE:'Um valor comercial está ausente ou em formato não suportado.',
};
export function salesIssueLabel(issue:SalesReadinessIssue){return`${issue.position===null?'':`Item ${issue.position}: `}${issueLabels[issue.code]??'Uma informação precisa de revisão.'}`;}
