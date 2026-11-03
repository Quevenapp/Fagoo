import { validateFiscalReview, FISCAL_REVIEW_LABELS as CORE_REVIEW_LABELS, type FiscalReview, type ReviewFinding } from '../../../../packages/fiscal-core/src/review.mjs';
import { fiscalDraftEnvelope, type FiscalDraftEnvelope, type FiscalDraftController } from './fiscal-drafts-model.ts';
// 029 only observes the selected 022 copy and the current product catalog.
// Its unchanged pipeline codes are scope reminders, not current module status.
export const FISCAL_REVIEW_LABELS:Readonly<Record<string,string>> = Object.freeze({
  ...CORE_REVIEW_LABELS,
  COMPANY_MISSING: 'A cópia inicial desta revisão não contém a identidade da empresa.',
  COMPANY_IE_MISSING: 'Inscrição estadual não informada na cópia inicial da empresa.',
  REGIME_UNCONFIRMED: 'A cópia inicial não contém confirmação do regime tributário. A configuração atual não é avaliada por este apontamento.',
  OPERATION_NATURE_MISSING: 'Natureza da operação não informada nesta revisão do rascunho.',
  OPERATION_SCOPE_UNMAPPED: 'Finalidade, destino, consumidor final e presença são conferidos no complemento fiscal; suas definições não são consultadas aqui.',
  NFCE_OPERATION_UNREVIEWED: 'A elegibilidade da operação como NFC-e não é avaliada por este relatório.',
  RECIPIENT_MUNICIPALITY_UNMAPPED: 'O código IBGE não integra a cópia inicial comparada aqui. Consulte o complemento fiscal.',
  RECIPIENT_TAX_STATUS_UNMAPPED: 'O indicador fiscal do destinatário e sua definição no complemento fiscal não são consultados aqui.',
  ITEM_FREE_REQUIRES_FISCAL_DATA: 'Item livre na cópia inicial. Seus dados fiscais próprios devem ser conferidos nas preparações fiscais.',
  GTIN_DECISION_REQUIRED: 'GTIN não informado nesta cópia inicial. Eventual escolha na preparação dos itens não é consultada aqui.',
  ITEM_ORIGIN_NOT_CAPTURED: 'A origem não integra a cópia inicial comparada aqui. Consulte a preparação dos itens fiscais.',
  ITEM_CEST_APPLICABILITY_UNREVIEWED: 'Este relatório não avalia a definição ou a aplicabilidade do CEST nas preparações fiscais.',
  ITEM_TRIBUTARY_FIELDS_UNMAPPED: 'Unidade, quantidade, preço e GTIN tributários são conferidos nas preparações fiscais; suas definições não são consultadas aqui.',
  ITEM_TAX_MAPPING_UNREVIEWED: 'As escolhas de CFOP, CST/CSOSN e grupos tributários não são consultadas por este relatório.',
  COMMERCIAL_ALLOCATION_UNREVIEWED: 'A cópia contém desconto global, frete ou outras despesas. Este relatório não consulta o rateio fiscal das preparações.',
  PAYMENT_FISCAL_MAPPING_REQUIRED: 'Códigos e grupos fiscais de pagamentos são avaliados no complemento fiscal, fora deste relatório.',
  TAX_REVIEW_REQUIRED: 'Este relatório não consulta a revisão tributária nem o cálculo da operação.',
  XML_PIPELINE_PENDING: 'A geração de XML, a validação XSD e a assinatura não são consultadas por este relatório. Veja as etapas correspondentes.',
  EMISSION_DEPENDENCIES_PENDING: 'Este relatório não consulta o certificado/cofre, o credenciamento, a comunicação ou a homologação do emissor.',
});
export type { ReviewFinding };
export type FiscalReviewController = Pick<FiscalDraftController, 'fiscalDraft'>;
export type FiscalReviewView = Omit<FiscalReview, 'basis'> & { basis: Omit<FiscalReview['basis'], 'draft'> & { draft: FiscalDraftEnvelope } };
export const REVIEW_SCOPE_LABELS = { document: 'Documento na cópia inicial', issuer: 'Emitente na cópia inicial', recipient: 'Destinatário na cópia inicial', item: 'Itens da cópia inicial', payments: 'Pagamentos na cópia inicial', dependencies: 'Fora do escopo deste relatório' };
export function fiscalReviewPath(id: string, revision: number) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) || !Number.isSafeInteger(revision) || revision < 1 || revision > 2147483647) throw new Error('Referência do rascunho inválida.');
  return '/v1/rascunhos-fiscais/' + id + '/conferencia?revision=' + revision;
}
export function fiscalReviewView(value: unknown, id: string, revision: number, snapshotHash: string): FiscalReviewView {
  try {
    const checked = validateFiscalReview(value, id, revision);
    const draft = fiscalDraftEnvelope(checked.basis.draft, id, revision);
    if (!/^[a-f0-9]{64}$/.test(snapshotHash) || draft.record.snapshot_hash !== snapshotHash) throw new Error('Revision mismatch');
    return { ...checked, basis: { ...checked.basis, draft } };
  } catch { throw new Error('Não foi possível conferir o relatório desta revisão. Consulte novamente o rascunho.'); }
}
