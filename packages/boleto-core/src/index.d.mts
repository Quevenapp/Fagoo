export class BoletoError extends Error { readonly code: string; }
export interface BoletoProfile {
  bank: '341' | '077'; wallet: '109' | '110';
  layout: 'itau-cnab400-2017-01' | 'inter-cnab400-v2.2-2024-08-26';
  accountId: string; agency: string; account: string; accountDigit: string;
  cnpj: string; companyName: string; contractVerified: boolean;
  agreementReference: string; simpleCollectionPolicyVerified: boolean;
  reservedRange?: { start: string; end: string; verified: boolean };
}
export interface BoletoInput {
  purpose: 'offline-validation'; profile: BoletoProfile;
  title: { amountCents: string; dueOn: string; referenceOn: string };
  allocation: { ourNumber: string; confirmed: boolean; reference: string };
}
export const BOLETO_FLAGS: Readonly<{
  purpose: 'offline-validation'; bankRegistered: false; bankAcceptanceVerified: false;
  homologationVerified: false; numberAllocationVerified: false;
  financialMutationPerformed: false; bankTransmissionPerformed: false;
  canIssue: false; canTransmit: false;
}>;
export const BOLETO_PENDING: readonly string[];
export type BoletoCandidate = typeof BOLETO_FLAGS & Readonly<{
  bank: '341'; wallet: '109'; currency: 'BRL'; barcode: string;
  digitableLine: string; formattedLine: string; freeField: string; dueFactor: string;
  ourNumberWithDigit: string; amountCents: string; dueOn: string; referenceOn: string;
  pending: readonly string[];
}>;
export function calculateDueFactor(input: { dueOn: string; referenceOn: string }): string;
export function calculateBarcodeDigit(base43: string): string;
/** Checks general digits only; no free-field or contractual attestation. */
export function barcodeToDigitableLine(barcode: string): Readonly<{ digits: string; formatted: string }>;
/** Inter110 currently throws BOLETO_INTER110_FIELD_LAYOUT_UNCONFIRMED. */
export function createBoletoDigits(input: BoletoInput): BoletoCandidate;
export interface Itau109CollectionTerms {
  profile: 'itau109-explicit-charges-v1'; monthlyInterestPercent: '1.00'; penaltyPercent: '2.00';
  penaltyToleranceDays: 1; punctualityDiscountPercent: '0.00'; species: 'DM'; acceptance: 'N';
  sourceInstructions: 'absent'; automaticProtest: false;
  resolution: null | {
    monthDays: 30; rounding: 'exact' | 'down' | 'half-up' | 'up'; dailyInterestCents: string;
    interestStartsOn: string; penaltyStartsOn: string;
    penaltyDateRule: 'due-plus-tolerance' | 'after-complete-tolerance-days';
    confirmed: true; reference: string;
  };
}
export interface Itau109TermsReview {
  readonly profile: 'itau109-explicit-charges-v1'; readonly amountCents: string; readonly dueOn: string;
  readonly source: Readonly<Omit<Itau109CollectionTerms, 'profile' | 'resolution'>>;
  readonly thirtyDayScenario: Readonly<{ selected: boolean; numeratorCents: string; denominator: '3000'; wholeDailyCents: string; remainder: string }>;
  readonly encodingReady: boolean;
  readonly encoding: null | Readonly<{ species: '01'; acceptance: 'N'; instructions: readonly ['10', '44'];
    dailyInterestCents: string; interestStartsOn: string; penaltyCode: '2'; penaltyPercentHundredths: '200';
    penaltyStartsOn: string; discountCents: '0'; discountUntil: null; protestDays: '00' }>;
  readonly resolution: Readonly<Itau109CollectionTerms['resolution']>;
  readonly pending: readonly string[]; readonly warnings: readonly string[];
  readonly bankPolicyVerified: false; readonly bankAcceptanceVerified: false;
  readonly bankTransmissionPerformed: false; readonly financialMutationPerformed: false; readonly automaticProtest: false;
}
/** Keeps nominal digits unchanged; unresolved fee conventions remain explicit pending items. */
export function createItau109BoletoTermsCandidate(input: BoletoInput & { collectionTerms: Itau109CollectionTerms }):
  BoletoCandidate & Readonly<{ collectionTerms: Itau109TermsReview }>;
/** Always visibly marked offline preview; not a complete or registered boleto. */
export function createItau109BarcodePreview(input: BoletoInput): BoletoCandidate & Readonly<{
  renderProfile: 'itau109-barcode-preview-v1'; mimeType: 'image/svg+xml'; svg: string;
  symbolModules: 405; barcodeWidthMm: 103; barcodeHeightMm: 13; quietZoneMm: 5;
  fullBoletoRendered: false; printedLayoutValidatedByBank: false;
}>;
/** Revalidates the complete captured v2 policy; never infers bank acceptance. */
export function createItau109OperationalBarcodePreviewV2(input: {snapshot:unknown;billingTitleId:string}): ReturnType<typeof createItau109BarcodePreview>;
