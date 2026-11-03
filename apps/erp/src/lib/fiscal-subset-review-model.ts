import {reviewRoute,captureReviewInput} from '../../../../packages/fiscal-authorization-runtime/src/review-protocol.mjs';
import {projectReviewPublic,type ReviewContext,type ReviewResult,type ReviewSaveInput} from '../../../../packages/fiscal-authorization-runtime/src/review-dto.mjs';
import {signedShape} from './fiscal-signed-model.ts';
import type {NativeRequestOptions} from './real-access.ts';
export type {ReviewContext,ReviewResult,ReviewSaveInput};
export const SUBSET_REVIEW_BASE='/v1/fiscal-authorization';
export type SubsetReviewSelected={action:'reviewContext';method:'GET';candidateId:string;signal?:AbortSignal}|{action:'reviewCommand';method:'GET';commandId:string;signal?:AbortSignal}|{action:'reviewSave';method:'POST';candidateId:string;payload:ReviewSaveInput;signal?:AbortSignal};
export function captureSubsetReviewRequest(path:string,options:NativeRequestOptions={}):SubsetReviewSelected{
 if(!signedShape(options,[],['method','body','signal'])||options.signal!==undefined&&!(options.signal instanceof AbortSignal)||typeof path!=='string'||/[?#%\\]/.test(path))throw Error('AUTHORIZATION_INVALID_REQUEST');
 const selected=reviewRoute(path,options.method??'GET',SUBSET_REVIEW_BASE);
 if(!selected)throw Error('AUTHORIZATION_INVALID_REQUEST');
 if(selected.action==='reviewCommand'?typeof selected.commandId!=='string':typeof selected.candidateId!=='string')throw Error('AUTHORIZATION_INVALID_REQUEST');
 if(selected.action==='reviewSave'&&selected.candidateId)return Object.freeze({action:'reviewSave',method:'POST',candidateId:selected.candidateId,payload:captureReviewInput(options.body),signal:options.signal});
 if(Object.hasOwn(options,'body'))throw Error('AUTHORIZATION_INVALID_REQUEST');
 if(selected.action==='reviewContext'&&selected.candidateId)return Object.freeze({action:'reviewContext',method:'GET',candidateId:selected.candidateId,signal:options.signal});
 if(selected.action==='reviewCommand'&&selected.commandId)return Object.freeze({action:'reviewCommand',method:'GET',commandId:selected.commandId,signal:options.signal});
 throw Error('AUTHORIZATION_INVALID_REQUEST');
}
export function subsetReviewResponse(raw:unknown,selected:SubsetReviewSelected):ReviewContext|ReviewResult{
 const binding=selected.action==='reviewSave'?{action:'save' as const,candidateId:selected.candidateId,commandId:selected.payload.command_id,input:selected.payload}:selected.action==='reviewContext'?{action:'context' as const,candidateId:selected.candidateId}:{action:'command' as const,commandId:selected.commandId};
 return projectReviewPublic(raw,binding);
}
/** A previous profile remains historical evidence, never consent for the current rules. */
export function subsetReviewInitialValues(context:ReviewContext):{choices:ReviewSaveInput['choices'];validUntil:string|null}{
 const same=context.review.matches_profile&&context.review.receipt!==null&&context.review.receipt.profile_hash===context.candidate.profile_hash;
 return {choices:same&&context.review.declaration?structuredClone(context.review.declaration) as ReviewSaveInput['choices']:{document:{operation:'unreviewed',recipient_regime:'unreviewed',acquisition_purpose:'unreviewed',payment:'unreviewed',excluded_groups:'unreviewed'},items:context.facts.items.map(item=>({position:item.position,classification:'unreviewed',benefit:'unreviewed',pis_cofins:'unreviewed',gtin:'unreviewed',st:'unreviewed',fcp:'unreviewed',credit:null}))},validUntil:same?context.review.receipt!.valid_until:null};
}
export const REVIEW_OPTIONS:Record<string,ReadonlyArray<readonly[string,string]>>={
 operation:[['unreviewed','Não revisado'],['internal_normal_sale','Venda interna normal'],['outside_scope','Outra operação']],
 recipient_regime:[['unreviewed','Não revisado'],['regular_icms','Regime normal de ICMS'],['simples','Simples Nacional'],['noncontributor','Não contribuinte']],
 acquisition_purpose:[['unreviewed','Não revisado'],['resale','Revenda'],['industrialization','Industrialização'],['final_consumption','Consumo final']],
 payment:[['unreviewed','Não revisado'],['matches_signed_document','Confere com a nota']],
 excluded_groups:[['unreviewed','Não revisado'],['not_applicable','Não se aplicam'],['applies','Há outra situação fiscal']],
 classification:[['unreviewed','Não revisado'],['reviewed_physical_goods','Mercadoria física conferida'],['outside_scope','Outro tipo de item']],
 benefit:[['unreviewed','Não revisado'],['not_applicable','Não se aplica'],['applies','Benefício aplicável']],
 pis_cofins:[['unreviewed','Não revisado'],['normal_unified_simples','Tributação normal no Simples'],['other','Outra tributação']],
 gtin:[['unreviewed','Não revisado'],['reviewed_absent','Produto sem GTIN, conferido'],['reviewed_identifiers','GTIN informado, conferido']],
 st:[['unreviewed','Não revisado'],['not_applicable','Não se aplica'],['documented_prior_retention','Retenção anterior documentada']],
 fcp:[['unreviewed','Não revisado'],['not_applicable','Não se aplica'],['documented_prior_retention','Retenção anterior documentada']],
};

/** Labels explain checks already performed by the backend; they do not define tax rules. */
export const REVIEW_ISSUES:Record<string,string>={
 BACKEND_CLASSIFICATION_REVIEW_MISSING:'A classificação fiscal ainda precisa ser revisada.',BACKEND_REVIEW_EXPIRED:'A revisão anterior perdeu a validade.',
 BENEFIT_APPLICABILITY_PENDING:'Confirme se há benefício fiscal.',BENEFIT_FIELD_OUTSIDE_PROFILE:'O benefício informado ainda não é atendido.',BENEFIT_REQUIRES_UNSUPPORTED_FIELD:'O benefício exige informações ainda não atendidas.',
 CHANGE_EXCEEDS_CASH_SCOPE:'O troco informado precisa de uma conferência adicional.',CREDIT_REVIEW_ON_NONCREDIT_ITEM:'Há comprovação de crédito em um item sem crédito previsto.',
 DOCUMENT_GROUP_OUTSIDE_PROFILE:'A nota contém um grupo fiscal ainda não atendido.',EMISSION_DATE_OUTSIDE_PROFILE:'A data da nota está fora do período coberto pelas regras.',EMISSION_DATE_OUTSIDE_REVIEW_WINDOW:'A data da nota está fora do período coberto pela revisão.',
 EXCLUDED_TAX_GROUPS_PENDING:'Confira as outras situações fiscais.',EXCLUDED_TAX_GROUP_APPLIES:'A operação envolve uma situação fiscal ainda não atendida.',
 FCP_APPLICABILITY_PENDING:'Confira a aplicação do Fundo de Combate à Pobreza.',FCP_RETENTION_GROUP_INCOMPLETE:'Complete os dados da retenção de FCP na preparação.',FCP_RETENTION_RATE_ZERO_OR_INVALID:'Confira a alíquota da retenção de FCP.',
 GS1_PREFIX_TABLE_NOT_PINNED:'A conferência automática da tabela de GTIN ainda está pendente.',GTIN_CHECK_DIGIT_INVALID:'O dígito verificador do GTIN é inválido.',GTIN_CLASSIFICATION_PENDING:'Confira a identificação GTIN.',GTIN_PAIR_MISMATCH:'Os códigos GTIN comercial e tributário divergem.',
 GTIN_CEAN_PREFIX_NOT_LISTED:'O prefixo do GTIN comercial não consta da tabela GS1 conferida. Revise o código.',GTIN_CEANTRIB_PREFIX_NOT_LISTED:'O prefixo do GTIN tributário não consta da tabela GS1 conferida. Revise o código.',
 ICMS_BRANCH:'A modalidade de ICMS ainda não é atendida.',ICMS_FIELD_OUTSIDE_BRANCH:'Há informações incompatíveis com a modalidade de ICMS.',ITEM_BRANCH_OUTSIDE_PROFILE:'Este tipo de item ainda não é atendido.',ITEM_CLASSIFICATION_FORMAT_INVALID:'A classificação do item precisa ser corrigida.',
 NFCE_CFOP_CSOSN_MISMATCH:'O CFOP e o CSOSN da NFC-e são incompatíveis.',NFCE_CSOSN101_NOT_ALLOWED:'O CSOSN 101 não é aceito nesta NFC-e.',NFCE_PAYMENT_TOTAL_TOO_LOW:'Os pagamentos da NFC-e não cobrem o total informado.',
 NFE_CFOP_CSOSN_OUTSIDE_INITIAL_SCOPE:'Esta combinação de CFOP e CSOSN ainda não é atendida.',NFE_CSOSN101_NONCONTRIBUTOR:'Confira o crédito de ICMS para o destinatário não contribuinte.',NFE_CSOSN500_CEST_REQUIRED:'Informe o CEST exigido para este item.',NFE_NONFINAL_RETENTION_REQUIRED:'Confira a retenção para esta operação que não é de consumo final.',
 OPERATION_CLASSIFICATION_PENDING:'Confira a classificação da operação.',OPERATION_OUTSIDE_PROFILE:'Esta operação ainda não é atendida.',PAYMENT_FACTS_PENDING:'Confira as condições de pagamento.',PAYMENT_METHOD_OUTSIDE_PROFILE:'Esta forma de pagamento ainda não é atendida.',PAYMENT_RECONCILIATION_OUTSIDE_INITIAL_SCOPE:'A conciliação destes pagamentos exige conferência adicional.',PAYMENT_VALUES_INVALID:'Confira os valores dos pagamentos.',
 PIS_COFINS_BRANCH_OUTSIDE_PROFILE:'A modalidade de PIS e COFINS ainda não é atendida.',PIS_COFINS_CLASSIFICATION_PENDING:'Confira a classificação de PIS e COFINS.',PIS_COFINS_REGIME_OUTSIDE_PROFILE:'Este regime de PIS e COFINS ainda não é atendido.',PRODUCT_CLASSIFICATION_OUTSIDE_PROFILE:'Esta classificação de produto ainda não é atendida.',PRODUCT_CLASSIFICATION_PENDING:'Confira a classificação do produto.',
 PROFILE_REVIEW_DATE_OUTSIDE_WINDOW:'As regras desta conferência precisam ser atualizadas.',RECIPIENT_OUTSIDE_PROFILE:'Esta situação do destinatário ainda não é atendida.',RETENTION_GROUP_INCOMPLETE:'Complete os dados da retenção na preparação.',REVIEW_OPERATION_OUTSIDE_PROFILE:'A operação escolhida ainda não é atendida.',SEM_CBENEF_NOT_SUPPORTED:'A indicação de benefício fiscal exige conferência adicional.',
 SN_CREDIT_DISCLOSURE_PENDING:'Confira as informações complementares sobre o crédito de ICMS.',SN_CREDIT_ELIGIBILITY_PENDING:'Falta comprovar o direito ao crédito de ICMS.',SN_CREDIT_PERIOD_OUTSIDE_INITIAL_SCOPE:'O período do crédito de ICMS ainda não é atendido.',SN_CREDIT_REVIEW_VALUES_MISMATCH:'Os valores do crédito divergem da comprovação.',SP_EXEMPT_IE_WITHOUT_EXCEPTION:'Confira a inscrição estadual ou a justificativa de isenção do destinatário.',ST_CLASSIFICATION_ON_NONST_ITEM:'A classificação de substituição tributária diverge do item.',ST_RETENTION_BASIS_PENDING:'Falta comprovar a retenção anterior de substituição tributária.',
};
